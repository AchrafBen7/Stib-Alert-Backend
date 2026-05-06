const Signalement = require("../models/Signalement");
const Arret = require("../models/Arret");
const Utilisateur = require("../models/Utilisateur");
const { analyserSignalement, genererResumeSignalements, traduireSignalement } = require("../config/openai");
const { emitSignalement } = require("../config/websocket");
const { getWaitingTimes } = require("../services/belgianMobility");
const { getScheduledStopDepartures } = require("../services/staticTimetableService");
const { COMMUNITY_ACTION, buildCommunityMeta, upsertCommunityAction } = require("../services/signalementCommunityService");
const { sendFavoriteIncidentPushes } = require("../services/assistantIncidentPushService");
const { syncOfficialPerturbations } = require("../services/stibOfficialSeedService");
const moment = require("moment");
const path = require("path");
const crypto = require("crypto");
const cloudinary = require("../config/cloudinary");
const { CloudinaryStorage } = require("multer-storage-cloudinary");
const multer = require("multer");

const parsePagination = (req) => {
	const page = Math.max(Number.parseInt(req.query.page || "1", 10), 1);
	const requestedLimit = Number.parseInt(req.query.limit || "25", 10);
	const limit = Math.min(Math.max(requestedLimit || 25, 1), 100);
	return { page, limit, skip: (page - 1) * limit };
};

const visibleSignalementQuery = (query = {}) => ({
	...query,
	moderationStatus: "approved",
});

const serializeSignalement = (signalement) => {
	const raw = typeof signalement.toObject === "function" ? signalement.toObject() : signalement;
	return {
		...raw,
		source: raw.source || "community",
		authorType: raw.authorType || "anonymous",
		moderationStatus: raw.moderationStatus || "approved",
		community: buildCommunityMeta(raw),
	};
};

function clientIp(req) {
	return String(req.ip || req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || "unknown");
}

function clientDeviceId(req) {
	return String(req.headers["x-stib-device-id"] || req.headers["x-device-id"] || "").trim();
}

function privacyHash(value) {
	const normalized = String(value || "").trim();
	if (!normalized) return null;
	const salt = process.env.SIGNALEMENT_PRIVACY_SALT || process.env.JWT_SECRET || "stib-alert";
	return crypto
		.createHmac("sha256", salt)
		.update(normalized)
		.digest("hex");
}

async function findRecentAnonymousDuplicate({ arretId, ligne, typeProbleme, reporterIpHash, reporterDeviceHash }) {
	if (!reporterIpHash && !reporterDeviceHash) return null;

	const since = new Date(Date.now() - 10 * 60 * 1000);
	const identityQuery = [];
	if (reporterIpHash) identityQuery.push({ reporterIpHash });
	if (reporterDeviceHash) identityQuery.push({ reporterDeviceHash });

	return Signalement.findOne({
		arretId,
		ligne,
		typeProbleme,
		authorType: "anonymous",
		dateSignalement: { $gte: since },
		status: { $ne: "resolved" },
		moderationStatus: { $in: ["pending", "approved"] },
		$or: identityQuery,
	}).lean();
}

let lastOfficialHydrationAt = 0;
let officialHydrationPromise = null;

async function ensureOfficialSignalementsForPublicList() {
	const cooldownMs = 2 * 60 * 1000;
	if (Date.now() - lastOfficialHydrationAt < cooldownMs) return;

	const hasActiveOfficial = await Signalement.exists(visibleSignalementQuery({
		source: "stib_officiel",
		status: "active",
	}));
	if (hasActiveOfficial) {
		lastOfficialHydrationAt = Date.now();
		return;
	}

	if (!officialHydrationPromise) {
		officialHydrationPromise = syncOfficialPerturbations()
			.catch((error) => {
				console.warn("[signalements] official on-demand sync failed:", error.message);
				return null;
			})
			.finally(() => {
				lastOfficialHydrationAt = Date.now();
				officialHydrationPromise = null;
			});
	}

	await officialHydrationPromise;
}

const storage = new CloudinaryStorage({
	cloudinary: cloudinary,
	params: {
		folder: "stib-alert", // nom du dossier dans Cloudinary
		allowed_formats: ["jpg", "jpeg", "png"],
		transformation: [{ width: 800, crop: "scale" }],
	},
});

exports.upload = multer({
	storage,

	fileFilter: function (req, file, cb) {
		const allowed = ["image/jpeg", "image/png", "image/jpg"];

		if (!allowed.includes(file.mimetype)) {
			return cb(new Error("Seulement les fichiers JPEG/PNG sont autorisés."), false);
		}

		cb(null, true);
	},

	limits: { fileSize: 2 * 1024 * 1024 }, // 2MB max
});

// 🔹 Fonction pour calculer la distance entre deux points (en km)
const distanceEntrePoints = (lat1, lon1, lat2, lon2) => {
	const R = 6371; // Rayon de la Terre en km
	const dLat = (lat2 - lat1) * (Math.PI / 180);
	const dLon = (lon2 - lon1) * (Math.PI / 180);
	const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
	const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
	return R * c;
};

const parseWaitingMinutes = (value) => {
	if (typeof value === "number" && Number.isFinite(value)) {
		return Math.max(Math.round(value), 0);
	}

	if (typeof value !== "string") return null;

	const normalized = value.trim().toLowerCase();
	if (!normalized) return null;
	if (normalized === "due" || normalized === "now") return 0;

	const match = normalized.match(/(\d+)/);
	if (!match) return null;

	const parsed = Number.parseInt(match[1], 10);
	return Number.isNaN(parsed) ? null : Math.max(parsed, 0);
};

const groupWaitingTimesByStop = async (line, arrets) => {
	if (!arrets.length) return new Map();

	const stopIds = arrets
		.map((arret) => arret.stop_id)
		.filter(Boolean);

	if (!stopIds.length) return new Map();

	try {
		const waitingTimes = await getWaitingTimes({ line, stopId: stopIds });
		const grouped = new Map();

		for (const item of waitingTimes.items) {
			const stopId = item.stopId ? String(item.stopId) : null;
			if (!stopId) continue;

			const minutes = parseWaitingMinutes(item.minutes);
			if (minutes === null) continue;

			if (!grouped.has(stopId)) {
				grouped.set(stopId, []);
			}

			grouped.get(stopId).push(minutes);
		}

		for (const [stopId, values] of grouped.entries()) {
			const uniqueSorted = [...new Set(values)].sort((a, b) => a - b);
			grouped.set(stopId, uniqueSorted);
		}

		return grouped;
	} catch (error) {
		console.error("[WaitingTimes] enrichissement ligne/arrêts impossible:", error.message);
		return new Map();
	}
};

exports.ajouterSignalement = async (req, res) => {
	try {
		const { nomArret, ligne, typeProbleme, description, latitude, longitude } = req.body;
		let photo = req.file ? req.file.path : undefined;

		const latitudeParsed = parseFloat(latitude);
		const longitudeParsed = parseFloat(longitude);

		let arret = await Arret.findOne({ nom: nomArret });

		if (!arret) return res.status(404).json({ message: `L'arrêt "${nomArret}" n'existe pas.` });

		if (!arret.lignesDesservies.includes(ligne)) {
			return res.status(400).json({ message: `L'arrêt "${nomArret}" ne dessert pas la ligne "${ligne}".` });
		}

		// 🔹 Vérification OpenAI pour éviter le spam
		const estValide = await analyserSignalement(description);
		if (!estValide) return res.status(400).json({ message: "Ce signalement ne respecte pas les règles." });

		// 🔍 Vérification de la distance GPS (si fournie)
		let confiance = "basse"; // ⚠️ Valeur par défaut si aucune position
		if (latitude && longitude) {
			const distance = distanceEntrePoints(latitudeParsed, longitudeParsed, arret.latitude, arret.longitude);

			if (distance < 0.2) confiance = "haute"; // ✅ Moins de 200m → Fiable
			else if (distance < 1) confiance = "moyenne"; // 🤔 Entre 200m et 1km → Acceptable
		}

		const isAuthenticatedAuthor = Boolean(req.user?.userId);
		const moderationStatus = isAuthenticatedAuthor ? "approved" : "pending";
		const authorType = isAuthenticatedAuthor ? "authenticated" : "anonymous";
		const reporterIpHash = privacyHash(clientIp(req));
		const reporterDeviceHash = privacyHash(clientDeviceId(req));

		if (!isAuthenticatedAuthor) {
			const duplicate = await findRecentAnonymousDuplicate({
				arretId: arret._id,
				ligne,
				typeProbleme,
				reporterIpHash,
				reporterDeviceHash,
			});

			if (duplicate) {
				return res.status(409).json({
					message: "Signalement déjà reçu récemment pour cette ligne et cet arrêt. Il est en attente de vérification.",
					moderationStatus: duplicate.moderationStatus,
				});
			}
		}

		// 🔹 Création du signalement avec "confiance"
		const signalement = await Signalement.create({
			utilisateurId: req.user?.userId,
			arretId: arret._id,
			authorType,
			moderationStatus,
			reporterIpHash,
			reporterDeviceHash,
			ligne,
			typeProbleme,
			description,
			photo,
			latitude: isNaN(latitudeParsed) ? undefined : latitudeParsed,
			longitude: isNaN(longitudeParsed) ? undefined : longitudeParsed,
			confiance,
		});

		if (moderationStatus === "approved") {
			// Only approved reports should be visible in realtime surfaces and push notifications.
			emitSignalement(signalement);
			sendFavoriteIncidentPushes({ ...signalement.toObject(), arretId: arret }, "new_signalement")
				.catch((pushError) => console.warn("[assistant incident push]", pushError.message));
		}

		res.status(201).json({
			message: moderationStatus === "pending"
				? "Signalement reçu. Il sera vérifié avant diffusion."
				: "Signalement ajouté avec succès.",
			signalement: {
				...serializeSignalement(signalement),
				dateSignalementLisible: moment(signalement.dateSignalement).format("YYYY-MM-DD HH:mm"),
			},
		});
	} catch (error) {
		res.status(500).json({ message: error.message });
	}
};

exports.signalerViaSiri = async (req, res) => {
	try {
		if (!req.user?.userId) {
			return res.status(401).json({ message: "Connexion requise pour signaler via Siri." });
		}

		const { nomArret, typeProbleme, description } = req.body;

		const typesValides = ["Retard", "Accident", "Panne", "Propreté", "Agression", "Incivilité", "Autre"];
		if (!nomArret || !typeProbleme || !typesValides.includes(typeProbleme)) {
			return res.status(400).json({ message: "Arrêt et type de problème requis." });
		}

		const arret = await Arret.findOne({ nom: { $regex: new RegExp(`^${nomArret.trim()}$`, "i") } });
		if (!arret) return res.status(404).json({ message: `L'arrêt "${nomArret}" n'existe pas.` });

		const ligne = arret.lignesDesservies?.[0];
		if (!ligne) return res.status(400).json({ message: `Aucune ligne connue pour l'arrêt "${nomArret}".` });

		const texteDescription = description?.trim() || "Signalé via Siri";
		const estValide = await analyserSignalement(texteDescription);
		if (!estValide) return res.status(400).json({ message: "Ce signalement ne respecte pas les règles." });

		const signalement = await Signalement.create({
			utilisateurId: req.user.userId,
			arretId: arret._id,
			authorType: "authenticated",
			moderationStatus: "approved",
			ligne,
			typeProbleme,
			description: texteDescription,
			confiance: "moyenne",
		});

		emitSignalement(signalement);
		sendFavoriteIncidentPushes({ ...signalement.toObject(), arretId: arret }, "new_signalement")
			.catch((e) => console.warn("[siri push]", e.message));

		res.status(201).json({
			message: `Signalement "${typeProbleme}" créé pour l'arrêt ${arret.nom} (ligne ${ligne}).`,
			ligne,
			nomArret: arret.nom,
			signalement: serializeSignalement(signalement),
		});
	} catch (error) {
		res.status(500).json({ message: error.message });
	}
};

exports.voirUnSignalementParArret = async (req, res) => {
	try {
		const { arretId, signalementId } = req.params;

		// Vérifier que l'arrêt existe
		const arret = await Arret.findById(arretId);
		if (!arret) {
			return res.status(404).json({ message: "Arrêt introuvable." });
		}

		// Chercher le signalement lié à cet arrêt
		const signalement = await Signalement.findOne(visibleSignalementQuery({ _id: signalementId, arretId }));
		if (!signalement) {
			return res.status(404).json({ message: "Signalement introuvable pour cet arrêt." });
		}

		// Retourner toutes les infos nécessaires
		res.json({
			...serializeSignalement(signalement),
			arret: arret.nom, // nom de l'arrêt pour affichage
		});
	} catch (error) {
		res.status(500).json({ message: error.message });
	}
};

// ✅ Ajout de la pagination (optionnelle)
exports.voirSignalements = async (req, res) => {
	try {
		const { page, limit, skip } = parsePagination(req);
		const query = {};

		if (req.query.ligne) query.ligne = req.query.ligne;
		if (req.query.arretId) query.arretId = req.query.arretId;
		if (req.query.source) {
			const source = String(req.query.source).trim().toLowerCase();
			if (["official", "stib", "stib_officiel"].includes(source)) {
				query.source = "stib_officiel";
			} else if (source === "community") {
				query.source = "community";
			}
		}

		if (page === 1) {
			await ensureOfficialSignalementsForPublicList();
		}

		const publicQuery = visibleSignalementQuery(query);

		const [signalements, total] = await Promise.all([
			Signalement.find(publicQuery)
				.sort({ dateSignalement: -1 })
				.skip(skip)
				.limit(limit)
				.populate("arretId"),
			Signalement.countDocuments(publicQuery),
		]);

		res.json({
			signalements: signalements.map(serializeSignalement),
			pagination: {
				page,
				limit,
				total,
				totalPages: Math.max(Math.ceil(total / limit), 1),
			},
		});
	} catch (error) {
		res.status(500).json({ message: error.message });
	}
};

exports.voirSignalementsModeration = async (req, res) => {
	try {
		const { page, limit, skip } = parsePagination(req);
		const status = ["pending", "rejected", "approved"].includes(req.query.status)
			? req.query.status
			: "pending";

		const [signalements, total] = await Promise.all([
			Signalement.find({ moderationStatus: status, source: "community" })
				.sort({ dateSignalement: -1 })
				.skip(skip)
				.limit(limit)
				.populate("arretId"),
			Signalement.countDocuments({ moderationStatus: status, source: "community" }),
		]);

		res.json({
			signalements: signalements.map(serializeSignalement),
			pagination: {
				page,
				limit,
				total,
				totalPages: Math.max(Math.ceil(total / limit), 1),
			},
		});
	} catch (error) {
		res.status(500).json({ message: error.message });
	}
};

exports.voirResumeModeration = async (_req, res) => {
	try {
		const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
		const [pending, approved24h, rejected24h, anonymousPending] = await Promise.all([
			Signalement.countDocuments({ source: "community", moderationStatus: "pending" }),
			Signalement.countDocuments({ source: "community", moderationStatus: "approved", moderatedAt: { $gte: since24h } }),
			Signalement.countDocuments({ source: "community", moderationStatus: "rejected", moderatedAt: { $gte: since24h } }),
			Signalement.countDocuments({ source: "community", authorType: "anonymous", moderationStatus: "pending" }),
		]);

		res.json({
			pending,
			anonymousPending,
			approved24h,
			rejected24h,
		});
	} catch (error) {
		res.status(500).json({ message: error.message });
	}
};

exports.approuverSignalement = async (req, res) => {
	try {
		const signalement = await Signalement.findOne({
			_id: req.params.id,
			source: "community",
			moderationStatus: "pending",
		}).populate("arretId");

		if (!signalement) {
			return res.status(404).json({ message: "Signalement en attente introuvable." });
		}

		signalement.moderationStatus = "approved";
		signalement.moderatedAt = new Date();
		signalement.moderatedBy = req.user?.userId;
		signalement.moderationReason = null;
		await signalement.save();

		emitSignalement(signalement);
		sendFavoriteIncidentPushes(signalement.toObject(), "new_signalement")
			.catch((pushError) => console.warn("[assistant incident push]", pushError.message));

		res.json({
			message: "Signalement approuvé.",
			signalement: serializeSignalement(signalement),
		});
	} catch (error) {
		res.status(500).json({ message: error.message });
	}
};

exports.rejeterSignalement = async (req, res) => {
	try {
		const reason = String(req.body?.reason || "").trim().slice(0, 280) || "Rejeté après modération.";
		const signalement = await Signalement.findOne({
			_id: req.params.id,
			source: "community",
			moderationStatus: "pending",
		});

		if (!signalement) {
			return res.status(404).json({ message: "Signalement en attente introuvable." });
		}

		signalement.moderationStatus = "rejected";
		signalement.status = "resolved";
		signalement.moderatedAt = new Date();
		signalement.moderatedBy = req.user?.userId;
		signalement.moderationReason = reason;
		await signalement.save();

		res.json({
			message: "Signalement rejeté.",
			signalement: serializeSignalement(signalement),
		});
	} catch (error) {
		res.status(500).json({ message: error.message });
	}
};

// ✅ Voir les signalements d’un arrêt spécifique
exports.voirSignalementsParArret = async (req, res) => {
	try {
		// 🔹 Récupérer l'arrêt spécifique
		const arret = await Arret.findById(req.params.id);
		if (!arret) {
			return res.status(404).json({ message: "Arrêt introuvable." });
		}

		// 🔹 Récupérer les signalements pour cet arrêt
		const { page, limit, skip } = parsePagination(req);
		const publicQuery = visibleSignalementQuery({ arretId: req.params.id });
		const [signalements, total] = await Promise.all([
			Signalement.find(publicQuery)
				.sort({ dateSignalement: -1 })
				.skip(skip)
				.limit(limit)
				.populate("arretId"),
			Signalement.countDocuments(publicQuery),
		]);

		// 🔹 Générer le résumé
		const resume = await genererResumeSignalements(signalements, arret.nom, signalements.length > 0 ? signalements[0].ligne : "N/A");

		res.json({
			resume,
			pagination: {
				page,
				limit,
				total,
				totalPages: Math.max(Math.ceil(total / limit), 1),
			},
			signalements: signalements.map((s) => ({
				id: s._id,
				ligne: s.ligne,
				typeProbleme: s.typeProbleme,
				description: s.description,
				photo: s.photo,
				date: s.dateSignalement,
				arret: arret.nom, // ✅ Correction ici pour bien afficher l'arrêt
				source: "community",
				status: s.status,
				community: buildCommunityMeta(s),
			})),
		});
	} catch (error) {
		res.status(500).json({ message: error.message });
	}
};

// ✅ Fonction pour voter pour un signalement
exports.voterSignalement = async (req, res) => {
	try {
		const { vote } = req.body; // "up" ou "down"
		const signalement = await Signalement.findById(req.params.id);

		if (!signalement) return res.status(404).json({ message: "Signalement introuvable" });

		const userId = req.user?.userId;
		if (userId) {
			const alreadyVoted = await Utilisateur.exists({
				_id: userId,
				votes: signalement._id,
			});
			if (alreadyVoted) {
				return res.status(409).json({
					message: "Vous avez déjà voté pour ce signalement.",
					signalement: serializeSignalement(signalement),
				});
			}
		}

		if (vote === "up") {
			signalement.votesPositifs += 1;
		} else if (vote === "down") {
			signalement.votesNegatifs += 1;
		}

		await signalement.save();

		// Ajouter l'ID du signalement aux votes de l'utilisateur connecté
		if (userId) {
			await Utilisateur.findByIdAndUpdate(userId, {
				$addToSet: { votes: signalement._id },
			});
		}

		// Si trop de votes négatifs → mise à jour de la confiance
		if (signalement.votesNegatifs >= 5) {
			await Signalement.findByIdAndUpdate(signalement._id, { confiance: "basse" });
		}

		res.json({
			message: "Vote enregistré !",
			signalement: serializeSignalement(signalement),
		});
	} catch (error) {
		res.status(500).json({ message: error.message });
	}
};

async function applyCommunityAction(req, res, action, successMessage) {
	try {
		const signalement = await Signalement.findById(req.params.id);
		if (!signalement) return res.status(404).json({ message: "Signalement introuvable" });

		const summary = upsertCommunityAction(signalement, req.user?.userId, action);
		await signalement.save();

		emitSignalement(signalement.toObject());
		const populatedSignalement = await Signalement.findById(signalement._id).populate("arretId");
		const eventType = action === COMMUNITY_ACTION.RESOLVED ? "resolved" : "still_blocked";
		sendFavoriteIncidentPushes(populatedSignalement.toObject(), eventType)
			.catch((pushError) => console.warn("[assistant incident push]", pushError.message));

		res.json({
			message: successMessage,
			status: summary.status,
			confidence: summary.confidence,
			community: buildCommunityMeta(signalement),
		});
	} catch (error) {
		res.status(500).json({ message: error.message });
	}
}

exports.confirmerSignalement = async (req, res) =>
	applyCommunityAction(req, res, COMMUNITY_ACTION.CONFIRM, "Signalement confirmé.");

exports.marquerToujoursBloque = async (req, res) =>
	applyCommunityAction(req, res, COMMUNITY_ACTION.STILL_BLOCKED, "Le signalement reste actif.");

exports.marquerResolu = async (req, res) =>
	applyCommunityAction(req, res, COMMUNITY_ACTION.RESOLVED, "Signalement marqué comme résolu.");

exports.signalerFauxSignalement = async (req, res) => {
	try {
		const ip = req.ip || req.headers["x-forwarded-for"]?.split(",")[0].trim() || "unknown";
		const signalement = await Signalement.findById(req.params.id);

		if (!signalement) return res.status(404).json({ message: "Signalement introuvable" });

		const alreadyReported = signalement.abuseReports?.some((r) => r.ip === ip);
		if (alreadyReported) {
			return res.status(409).json({ message: "Vous avez déjà signalé ce signalement." });
		}

		signalement.abuseReports = signalement.abuseReports || [];
		signalement.abuseReports.push({ ip });
		signalement.signalements += 1;

		if (signalement.signalements >= 3) {
			await Signalement.findByIdAndDelete(signalement._id);
			return res.json({ message: "Ce signalement a été supprimé car trop de personnes l'ont signalé comme faux." });
		}

		await signalement.save();
		res.json({ message: "Signalement signalé comme faux." });
	} catch (error) {
		res.status(500).json({ message: error.message });
	}
};
exports.supprimerSignalement = async (req, res) => {
	try {
		const signalement = await Signalement.findById(req.params.id);

		if (!signalement) return res.status(404).json({ message: "Signalement introuvable" });

		// ✅ Vérifier si l'utilisateur est ADMIN
		if (req.user.role !== "Admin") {
			return res.status(403).json({ message: "❌ Seuls les administrateurs peuvent supprimer un signalement." });
		}

		await signalement.deleteOne();
		res.json({ message: "✅ Signalement supprimé avec succès par un administrateur." });
	} catch (error) {
		res.status(500).json({ message: error.message });
	}
};

// ✅ Voir toutes les lignes ayant des signalements
exports.voirLignesDisponibles = async (req, res) => {
	try {
		const lignes = await Signalement.distinct("ligne", visibleSignalementQuery());
		res.json(lignes);
	} catch (error) {
		res.status(500).json({ message: error.message });
	}
};

// ✅ Voir tous les arrêts d’une ligne spécifique
exports.voirArretsParLigne = async (req, res) => {
	try {
		const { ligne } = req.params;
		const arrets = await Arret.find({ lignesDesservies: ligne }).lean();
		const waitingTimesByStop = await groupWaitingTimesByStop(ligne, arrets);

		const enriched = await Promise.all(arrets.map(async (arret) => {
			const nextPassages = waitingTimesByStop.get(String(arret.stop_id)) || [];
			let effectivePassages = nextPassages;
			let nextPassageSource = nextPassages.length ? "realtime" : null;

			if (!effectivePassages.length) {
				const scheduled = await getScheduledStopDepartures({
					stopIds: [
						arret.stop_id,
						arret.merged_stop_id,
						...(arret.physicalStopIds || []),
					],
					stopName: arret.nom,
					lines: [ligne],
					line: ligne,
					limit: 3,
				});
				effectivePassages = scheduled.map((item) => item.minutes);
				nextPassageSource = effectivePassages.length ? "scheduled" : null;
			}

			return {
				...arret,
				nextPassageMinutes: effectivePassages[0] ?? null,
				nextPassages: effectivePassages.slice(0, 3),
				nextPassageSource,
			};
		}));

		res.json(enriched);
	} catch (error) {
		res.status(500).json({ message: error.message });
	}
};

// ✅ Voir les signalements d’un arrêt spécifique pour une ligne
exports.voirSignalementsParLigneEtArret = async (req, res) => {
	try {
		const { ligne, arretId } = req.params;
		const { page, limit, skip } = parsePagination(req);
		const query = visibleSignalementQuery({ ligne, arretId });
		const [signalements, total] = await Promise.all([
			Signalement.find(query)
				.sort({ dateSignalement: -1 })
				.skip(skip)
				.limit(limit)
				.populate("arretId"),
			Signalement.countDocuments(query),
		]);
		res.json({
			signalements: signalements.map(serializeSignalement),
			pagination: {
				page,
				limit,
				total,
				totalPages: Math.max(Math.ceil(total / limit), 1),
			},
		});
	} catch (error) {
		res.status(500).json({ message: error.message });
	}
};

exports.traduireSignalement = async (req, res) => {
	try {
		const { id } = req.params; // ID du signalement à traduire
		const signalement = await Signalement.findOne(visibleSignalementQuery({ _id: id }));

		if (!signalement) {
			return res.status(404).json({ message: "Signalement introuvable" });
		}

		// 🔹 Traduire la description à la demande
		const traduction = await traduireSignalement(signalement.description);

		res.json({
			original: signalement.description,
			traductions: traduction, // ✅ Retourne FR, NL, EN
		});
	} catch (error) {
		res.status(500).json({ message: error.message });
	}
};
