const Utilisateur = require("../models/Utilisateur");
const Signalement = require("../models/Signalement");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const redis = require("../config/redis");
const sendMail = require("../config/Mail");
const { predireTendances } = require("../config/openai");
const crypto = require("crypto");
const { getWaitingTimes } = require("../services/belgianMobility");
const { registerDevice } = require("../services/oneSignalService");
const { verifyAppleIdentityToken } = require("../services/appleSignInService");

const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function generateRefreshToken() {
	const raw = crypto.randomBytes(40).toString("hex");
	const hash = crypto.createHash("sha256").update(raw).digest("hex");
	return { raw, hash };
}

async function buildAuthResponse(utilisateur) {
	const token = jwt.sign({ userId: utilisateur._id }, process.env.JWT_SECRET, { expiresIn: "7d" });

	if (redis) {
		try {
			await redis.setex(`auth:${token}`, 604800, JSON.stringify({
				userId: utilisateur._id,
				email: utilisateur.email,
				nom: utilisateur.nom,
				role: utilisateur.role,
			}));
		} catch (error) {
			console.warn("[AUTH] Redis auth cache write failed:", error.message);
		}
	}

	let rawRefresh = null;
	try {
		const generated = generateRefreshToken();
		rawRefresh = generated.raw;
		await Utilisateur.findByIdAndUpdate(utilisateur._id, {
			refreshToken: generated.hash,
			refreshTokenExpiry: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
		});
	} catch (error) {
		rawRefresh = null;
		console.warn("[AUTH] Refresh token persistence failed:", error.message);
	}

	const sanitized = utilisateur.toObject ? utilisateur.toObject() : { ...utilisateur };
	delete sanitized.motDePasse;

	return {
		utilisateur: sanitized,
		token,
		refreshToken: rawRefresh,
	};
}

const buildFavorisDetails = async (favoris = []) => {
	const favoriIds = favoris.map((favori) => favori._id || favori);
	if (favoriIds.length === 0) return [];

	const now = new Date();
	const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
	const signalements = await Signalement.find({
		arretId: { $in: favoriIds },
		dateSignalement: { $gte: since },
		status: { $in: ["active", "grouped"] },
		moderationStatus: "approved",
		$or: [
			{ expiresAt: { $exists: false } },
			{ expiresAt: null },
			{ expiresAt: { $gt: now } },
		],
	})
		.sort({ dateSignalement: -1 })
		.select("arretId ligne typeProbleme votesPositifs confiance dateSignalement status moderationStatus expiresAt");

	const grouped = new Map();
	for (const signalement of signalements) {
		const key = signalement.arretId.toString();
		if (!grouped.has(key)) grouped.set(key, []);
		grouped.get(key).push(signalement);
	}

	let waitingTimesByStop = new Map();
	try {
		const stopIds = favoris
			.map((favori) => favori.stop_id || favori.stopId || favori.pointid || null)
			.filter(Boolean);
		if (stopIds.length > 0) {
			const waitingTimesResult = await getWaitingTimes({ stopId: stopIds });
			for (const item of waitingTimesResult.items) {
				if (!item.stopId) continue;
				if (!waitingTimesByStop.has(item.stopId)) waitingTimesByStop.set(item.stopId, []);
				waitingTimesByStop.get(item.stopId).push(item);
			}
		}
	} catch (error) {
		console.warn("WaitingTimes fallback skipped:", error.message);
	}

	return favoris.map((favori) => {
		const stop = favori.toObject ? favori.toObject() : favori;
		const recent = grouped.get(stop._id.toString()) ?? [];
		const recentCount = recent.length;
		const latest = recent[0];
		const status = recentCount === 0 ? "Normal" : recentCount >= 4 ? "Bloqué" : "Perturbé";
		const crowding = recentCount >= 4 ? "Haute" : recentCount >= 2 ? "Moyenne" : "Faible";
		const waitingItems = waitingTimesByStop.get(stop.stop_id) ?? [];
		const nextPassageMinutes = waitingItems
			.map((item) => Number.parseInt(String(item.minutes), 10))
			.filter((value) => Number.isFinite(value) && value >= 0)
			.sort((a, b) => a - b)[0] ?? null;
		return {
			...stop,
			status,
			crowding,
			signalementCount: recentCount,
			primaryLine: latest?.ligne || stop.lignesDesservies?.[0] || null,
			lastProblemType: latest?.typeProbleme || null,
			lastConfidence: latest?.confiance || null,
			nextPassageMinutes,
			lastUpdatedAt: latest?.dateSignalement || null,
		};
	});
};

const sanitizeRoutine = (routine, favorisDetails = []) => {
	if (!routine) return null;

	const favoriteIds = new Set(favorisDetails.map((item) => String(item._id || item.id)));
	const homeStopId = routine.homeStopId ? String(routine.homeStopId._id || routine.homeStopId) : null;
	const workStopId = routine.workStopId ? String(routine.workStopId._id || routine.workStopId) : null;

	return {
		enabled: Boolean(routine.enabled && (homeStopId || workStopId)),
		homeLabel: routine.homeLabel || "Domicile",
		workLabel: routine.workLabel || "Travail",
		departureTime: routine.departureTime || "08:15",
		homeStopId: homeStopId && favoriteIds.has(homeStopId) ? homeStopId : null,
		workStopId: workStopId && favoriteIds.has(workStopId) ? workStopId : null,
	};
};

// ✅ Inscription avec Code d'Activation
exports.inscription = async (req, res) => {
	try {
		const { nom, email, motDePasse } = req.body;

		const utilisateurExiste = await Utilisateur.findOne({ email });
		if (utilisateurExiste) {
			return res.status(400).json({ message: "Cet email est déjà utilisé." });
		}

		const hashedPassword = await bcrypt.hash(motDePasse, 12);
		const activationCode = Math.floor(1000 + Math.random() * 9000).toString();
		const activationToken = jwt.sign(
			{ nom, email, activationCode },
			process.env.ACTIVATION_SECRET,
			{ expiresIn: "10m" }
		);

		if (!redis) {
			return res.status(500).json({ message: "Redis est requis pour l'activation par OTP." });
		}
		await redis.setex(`activation:${email}`, 600, activationCode);
		await redis.setex(`pending:${email}`, 600, hashedPassword);

		// Envoyer l'email avec le code OTP
		const emailContent = `<h1>Votre code d'activation : ${activationCode}</h1>`;
		await sendMail(email, "Activation de votre compte STIB Alert", emailContent);

		res.status(201).json({
			message: `Code d'activation envoyé à ${email}`,
			activationToken,
		});
	} catch (error) {
		res.status(500).json({ message: error.message });
	}
};

// ✅ Renvoyer un nouveau code d'activation
exports.renvoyerCode = async (req, res) => {
	try {
		const { activationToken } = req.body;

		const decoded = jwt.decode(activationToken);
		if (!decoded?.email || !decoded?.nom) {
			return res.status(400).json({ message: "Token d'activation invalide." });
		}

		const { nom, email } = decoded;

		const utilisateurExiste = await Utilisateur.findOne({ email });
		if (utilisateurExiste) {
			return res.status(400).json({ message: "Ce compte est déjà activé. Connectez-vous." });
		}

		if (!redis) {
			return res.status(500).json({ message: "Redis est requis pour l'activation." });
		}

		const pendingHash = await redis.get(`pending:${email}`);
		if (!pendingHash) {
			return res.status(400).json({ message: "L'inscription a expiré. Recommencez depuis le début." });
		}

		const activationCode = Math.floor(1000 + Math.random() * 9000).toString();
		const newToken = jwt.sign(
			{ nom, email, activationCode },
			process.env.ACTIVATION_SECRET,
			{ expiresIn: "10m" }
		);

		await redis.setex(`activation:${email}`, 600, activationCode);
		await redis.setex(`pending:${email}`, 600, pendingHash);

		const emailContent = `<h1>Votre nouveau code d'activation : ${activationCode}</h1>`;
		await sendMail(email, "Nouveau code d'activation STIB Alert", emailContent);

		res.status(200).json({ message: `Nouveau code envoyé à ${email}`, activationToken: newToken });
	} catch (error) {
		res.status(500).json({ message: error.message });
	}
};

// ✅ Activer le compte avec le Code OTP
exports.activerCompte = async (req, res) => {
	try {
		const { activationToken, activationCode } = req.body;
		const decoded = jwt.verify(activationToken, process.env.ACTIVATION_SECRET);

		if (!redis) {
			return res.status(500).json({ message: "Redis est requis pour l'activation par OTP." });
		}
		const storedCode = await redis.get(`activation:${decoded.email}`);
		if (!storedCode || storedCode !== activationCode) {
			return res.status(400).json({ message: "Code d'activation incorrect ou expiré." });
		}

		const storedHash = await redis.get(`pending:${decoded.email}`);
		if (!storedHash) {
			return res.status(400).json({ message: "Inscription expirée. Recommencez." });
		}

		const { nom, email } = decoded;
		const utilisateurExiste = await Utilisateur.findOne({ email });
		if (utilisateurExiste) {
			await Promise.allSettled([
				redis.del(`activation:${email}`),
				redis.del(`pending:${email}`),
			]);
			const auth = await buildAuthResponse(utilisateurExiste);
			return res.status(200).json({
				message: "Compte deja active. Session ouverte avec succes.",
				...auth,
			});
		}

		const utilisateur = await Utilisateur.create({ nom, email, motDePasse: storedHash });

		await Promise.allSettled([
			redis.del(`activation:${email}`),
			redis.del(`pending:${email}`),
		]);
		const auth = await buildAuthResponse(utilisateur);
		res.status(201).json({ message: "Compte activé avec succès !", ...auth });
	} catch (error) {
		res.status(500).json({ message: error.message });
	}
};

// ✅ Sign in with Apple (iOS only — the client sends the identity token issued
// by AuthenticationServices). Idempotent: same Apple user → same account.
exports.appleSignin = async (req, res) => {
	try {
		const { identityToken, fullName } = req.body || {};
		if (!identityToken) {
			return res.status(400).json({ message: "identityToken requis." });
		}

		let appleClaims;
		try {
			appleClaims = await verifyAppleIdentityToken(identityToken);
		} catch (verifyErr) {
			console.warn("[apple-signin] verification failed:", verifyErr.message);
			return res.status(401).json({ message: "Identity token invalide." });
		}

		// Normalise the Apple-provided email the same way email/password signup
		// does (lowercase + trim). Without this, an existing account created as
		// "Achraf@x.com" wouldn't match Apple's "achraf@x.com" and a duplicate
		// account would be created instead of linking.
		const appleEmail = appleClaims.email
			? String(appleClaims.email).trim().toLowerCase()
			: null;

		// First try to match by appleUserId (stable across email rotations on
		// Apple's side, including the private-relay rotation case).
		let utilisateur = await Utilisateur.findOne({ appleUserId: appleClaims.sub });

		// Fall back to email match for first-time sign-ins where we have an
		// email and the user previously signed up another way.
		if (!utilisateur && appleEmail) {
			utilisateur = await Utilisateur.findOne({ email: appleEmail });
			if (utilisateur) {
				utilisateur.appleUserId = appleClaims.sub;
				await utilisateur.save();
			}
		}

		// Create on first sign-in.
		if (!utilisateur) {
			const fallbackEmail = appleEmail
				|| `apple_${appleClaims.sub.slice(0, 12)}@stibalert.invalid`;
			const displayName = (typeof fullName === "string" && fullName.trim())
				|| (appleEmail ? appleEmail.split("@")[0] : "Utilisateur Apple");

			utilisateur = await Utilisateur.create({
				nom: displayName,
				email: fallbackEmail,
				motDePasse: null,           // Apple-only: no local password
				appleUserId: appleClaims.sub,
				notifications: true,
				langue: "FR",
			});
		}

		const auth = await buildAuthResponse(utilisateur);
		return res.json({ message: "Connexion Apple réussie", ...auth });
	} catch (error) {
		console.error("[apple-signin]", error);
		return res.status(500).json({ message: "Connexion Apple impossible." });
	}
};

// ✅ Connexion d'un utilisateur
exports.connexion = async (req, res) => {
	try {
		const { email, motDePasse } = req.body;

		const utilisateur = await Utilisateur.findOne({ email });
		// Reject email/password login for Apple-only accounts (no local hash).
		if (!utilisateur || !utilisateur.motDePasse) {
			return res.status(401).json({ message: "Email ou mot de passe incorrect." });
		}
		if (!(await bcrypt.compare(motDePasse, utilisateur.motDePasse))) {
			return res.status(401).json({ message: "Email ou mot de passe incorrect." });
		}
		const auth = await buildAuthResponse(utilisateur);
		res.json({ message: "Connexion réussie", ...auth });
	} catch (error) {
		res.status(500).json({ message: error.message });
	}
};

exports.voirMoi = async (req, res) => {
	try {
	const utilisateur = await Utilisateur.findById(req.user.userId)
			.select("-motDePasse")
			.populate("favoris", "nom latitude longitude lignesDesservies stop_id")
			.populate("routine.homeStopId", "nom latitude longitude lignesDesservies stop_id")
			.populate("routine.workStopId", "nom latitude longitude lignesDesservies stop_id");
		if (!utilisateur) return res.status(404).json({ message: "Utilisateur introuvable." });
		const data = utilisateur.toObject();
		const favorisDetails = await buildFavorisDetails(utilisateur.favoris);
		res.json({
			...data,
			favorisDetails,
			favoriteLines: data.favoriteLines || [],
			routine: sanitizeRoutine(data.routine, favorisDetails),
		});
	} catch (error) {
		res.status(500).json({ message: error.message });
	}
};

exports.deconnexion = async (req, res) => {
	try {
		if (!req.headers.authorization) {
			return res.status(400).json({ message: "Aucun token fourni." });
		}
		const token = req.headers.authorization.split(" ")[1];
		if (redis) {
			await redis.del(`auth:${token}`);
		}
		if (req.user?.userId) {
			await Utilisateur.findByIdAndUpdate(req.user.userId, {
				refreshToken: null,
				refreshTokenExpiry: null,
			});
		}
		res.json({ message: "Déconnexion réussie !" });
	} catch (error) {
		res.status(500).json({ message: error.message });
	}
};

exports.refresh = async (req, res) => {
	try {
		const { refreshToken } = req.body;
		if (!refreshToken) {
			return res.status(400).json({ message: "Refresh token manquant." });
		}

		const hash = crypto.createHash("sha256").update(refreshToken).digest("hex");
		const utilisateur = await Utilisateur.findOne({ refreshToken: hash });

		if (!utilisateur || !utilisateur.refreshTokenExpiry || utilisateur.refreshTokenExpiry < new Date()) {
			return res.status(401).json({ message: "Refresh token invalide ou expiré." });
		}
		const auth = await buildAuthResponse(utilisateur);
		res.json({ token: auth.token, refreshToken: auth.refreshToken });
	} catch (error) {
		res.status(500).json({ message: error.message });
	}
};

// ✅ Voir le profil d'un utilisateur
exports.voirProfil = async (req, res) => {
	try {
		const utilisateur = await Utilisateur.findById(req.params.id)
			.populate("favoris votes")
			.populate("routine.homeStopId", "nom latitude longitude lignesDesservies stop_id")
			.populate("routine.workStopId", "nom latitude longitude lignesDesservies stop_id");
		if (!utilisateur) return res.status(404).json({ message: "Utilisateur introuvable." });

		const data = utilisateur.toObject();
		delete data.motDePasse;
		const favorisDetails = await buildFavorisDetails(utilisateur.favoris);
		res.json({
			...data,
			favorisDetails,
			favoriteLines: data.favoriteLines || [],
			routine: sanitizeRoutine(data.routine, favorisDetails),
		});
	} catch (error) {
		res.status(500).json({ message: error.message });
	}
};

// ✅ Modifier le profil d'un utilisateur (champs whitelistés)
exports.modifierProfil = async (req, res) => {
	try {
		const allowed = [
			"nom",
			"photoProfil",
			"langue",
			"notifications",
			"weeklyDigestEnabled",
			"preTripPushEnabled",
			"communityClusterPushEnabled",
			"mercisPushEnabled",
			"quietHoursEnabled",
			"quietHoursStartHour",
			"quietHoursEndHour",
		];
		const update = {};
		for (const key of allowed) {
			if (req.body[key] !== undefined) update[key] = req.body[key];
		}
		if (req.body.favoriteLines !== undefined) {
			update.favoriteLines = [...new Set((req.body.favoriteLines || [])
				.map((line) => String(line || "").trim().toUpperCase())
				.filter(Boolean))];
		}
		// #3 — Favoris multi-opérateurs : on remplace l'ensemble (le client
		// envoie la liste complète, idempotent). Dédup par op:stopId, opérateurs
		// hors STIB uniquement, coordonnées validées.
		if (req.body.operatorFavorites !== undefined) {
			const allowedOps = new Set(["sncb", "delijn", "tec"]);
			const seen = new Set();
			update.operatorFavorites = (Array.isArray(req.body.operatorFavorites) ? req.body.operatorFavorites : [])
				.map((f) => ({
					op: String(f?.op || "").trim().toLowerCase(),
					stopId: String(f?.stopId || "").trim(),
					name: String(f?.name || "").trim().slice(0, 160),
					lat: Number.isFinite(Number(f?.lat)) ? Number(f.lat) : null,
					lng: Number.isFinite(Number(f?.lng)) ? Number(f.lng) : null,
				}))
				.filter((f) => {
					if (!allowedOps.has(f.op) || !f.stopId) return false;
					const key = `${f.op}:${f.stopId}`;
					if (seen.has(key)) return false;
					seen.add(key);
					return true;
				})
				.slice(0, 100);
		}
		if (req.body.routine !== undefined) {
			update.routine = {
				enabled: Boolean(req.body.routine?.enabled),
				homeLabel: req.body.routine?.homeLabel || "Domicile",
				workLabel: req.body.routine?.workLabel || "Travail",
				departureTime: req.body.routine?.departureTime || "08:15",
				homeStopId: req.body.routine?.homeStopId || null,
				workStopId: req.body.routine?.workStopId || null,
			};
		}
		const utilisateur = await Utilisateur.findByIdAndUpdate(req.params.id, update, {
			new: true,
			runValidators: true,
		})
			.select("-motDePasse")
			.populate("favoris", "nom latitude longitude lignesDesservies stop_id")
			.populate("routine.homeStopId", "nom latitude longitude lignesDesservies stop_id")
			.populate("routine.workStopId", "nom latitude longitude lignesDesservies stop_id");
		if (!utilisateur) return res.status(404).json({ message: "Utilisateur introuvable." });
		const data = utilisateur.toObject();
		const favorisDetails = await buildFavorisDetails(utilisateur.favoris);
		res.json({
			...data,
			favorisDetails,
			favoriteLines: data.favoriteLines || [],
			routine: sanitizeRoutine(data.routine, favorisDetails),
		});
	} catch (error) {
		res.status(500).json({ message: error.message });
	}
};

// ✅ Récupérer les votes de l'utilisateur
exports.voirVotesUtilisateur = async (req, res) => {
	try {
		const utilisateur = await Utilisateur.findById(req.params.id).populate("votes");
		if (!utilisateur) return res.status(404).json({ message: "Utilisateur introuvable." });

		res.json(utilisateur.votes);
	} catch (error) {
		res.status(500).json({ message: error.message });
	}
};

exports.modifierLangueUtilisateur = async (req, res) => {
	try {
		const utilisateur = await Utilisateur.findByIdAndUpdate(req.params.id, req.body, { new: true });

		if (!utilisateur) return res.status(404).json({ message: "Utilisateur introuvable." });

		res.json({ message: "Langue mise à jour.", utilisateur });
	} catch (error) {
		res.status(500).json({ message: error.message });
	}
};

exports.predireEtNotifier = async (req, res) => {
	try {
		// Récupérer les signalements des dernières 24h
		const signalementsRecent = await Signalement.find({ dateSignalement: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } });

		// 🔹 Générer une prévision avec OpenAI
		const prediction = await predireTendances(signalementsRecent);

		// Récupérer les utilisateurs abonnés aux notifications
		const utilisateurs = await Utilisateur.find({ notifications: true });

		// Simulation d'envoi des notifications
		utilisateurs.forEach((user) => {
			console.log(`📢 Notification envoyée à ${user.email} : ${prediction}`);
		});

		res.json({ message: "Prédiction envoyée aux abonnés.", prediction });
	} catch (error) {
		res.status(500).json({ message: error.message });
	}
};
exports.enregistrerTokenFCM = async (req, res) => {
	try {
		const tokenPush = req.body.tokenPush || req.body.tokenFCM;
		const oneSignalPlayerId = req.body.oneSignalPlayerId;
		const utilisateur = await Utilisateur.findById(req.user.userId);

		if (!utilisateur) {
			return res.status(404).json({ message: "Utilisateur introuvable." });
		}

		if (tokenPush) {
			utilisateur.tokenPush = tokenPush;
		}
		if (oneSignalPlayerId) {
			utilisateur.oneSignalPlayerId = oneSignalPlayerId;
		} else if (tokenPush) {
			try {
				const registration = await registerDevice({
					userId: String(utilisateur._id),
					token: tokenPush,
					platform: "ios",
				});
				if (registration?.id) {
					utilisateur.oneSignalPlayerId = registration.id;
				}
			} catch (pushError) {
				console.warn("[ONESIGNAL] device registration failed:", pushError.message);
			}
		}
		await utilisateur.save();

		res.json({
			message: "Token push enregistré avec succès.",
			oneSignalPlayerId: utilisateur.oneSignalPlayerId || null,
		});
	} catch (error) {
		res.status(500).json({ message: error.message });
	}
};
exports.supprimerCompte = async (req, res) => {
	try {
		const userId = req.params.id;

		const token = req.headers.authorization?.split(" ")[1];
		if (token && redis) {
			await redis.del(`auth:${token}`);
		}

		await Signalement.deleteMany({ utilisateur: userId });
		await Utilisateur.findByIdAndDelete(userId);

		res.json({ message: "Compte supprimé avec succès." });
	} catch (error) {
		res.status(500).json({ message: error.message });
	}
};

exports.ajouterOuRetirerFavori = async (req, res) => {
	try {
		const { id, arretId } = req.params;

		const utilisateur = await Utilisateur.findById(id);
		if (!utilisateur) return res.status(404).json({ message: "Utilisateur introuvable." });

		const index = utilisateur.favoris.findIndex((favori) => String(favori) === String(arretId));

		if (index > -1) {
			// L'arrêt est déjà en favoris, on le retire
			utilisateur.favoris.splice(index, 1);
			await utilisateur.save();
			await utilisateur.populate("favoris", "nom latitude longitude lignesDesservies");
			const favorisDetails = await buildFavorisDetails(utilisateur.favoris);
			return res.json({
				message: "Arrêt retiré des favoris.",
				favoris: utilisateur.favoris.map((favori) => favori._id),
				favorisDetails,
			});
		} else {
			// L'arrêt n'est pas encore en favoris, on l'ajoute
			utilisateur.favoris.push(arretId);
			await utilisateur.save();
			await utilisateur.populate("favoris", "nom latitude longitude lignesDesservies");
			const favorisDetails = await buildFavorisDetails(utilisateur.favoris);
			return res.json({
				message: "Arrêt ajouté aux favoris.",
				favoris: utilisateur.favoris.map((favori) => favori._id),
				favorisDetails,
			});
		}
	} catch (error) {
		res.status(500).json({ message: error.message });
	}
};
