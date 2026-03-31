const Utilisateur = require("../models/Utilisateur");
const Signalement = require("../models/Signalement");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const redis = require("../config/redis");
const sendMail = require("../config/Mail");
const { predireTendances } = require("../config/openai");
const crypto = require("crypto");

// ✅ Inscription avec Code d'Activation
exports.inscription = async (req, res) => {
	try {
		const { nom, email, motDePasse } = req.body;

		const utilisateurExiste = await Utilisateur.findOne({ email });
		if (utilisateurExiste) {
			return res.status(400).json({ message: "Cet email est déjà utilisé." });
		}

		const hashedPassword = await bcrypt.hash(motDePasse, 10);
		const activationCode = Math.floor(1000 + Math.random() * 9000).toString(); // Code à 4 chiffres
		const activationToken = jwt.sign(
			{ nom, email, motDePasse: hashedPassword, activationCode },
			process.env.ACTIVATION_SECRET,
			{ expiresIn: "10m" } // Expire en 10 minutes
		);

		// Stocker le code OTP dans Redis (expire en 10 min)
		if (!redis) {
			return res.status(500).json({ message: "Redis est requis pour l'activation par OTP." });
		}
		await redis.setex(`activation:${email}`, 600, activationCode);

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

// ✅ Activer le compte avec le Code OTP
exports.activerCompte = async (req, res) => {
	try {
		const { activationToken, activationCode } = req.body;
		const decoded = jwt.verify(activationToken, process.env.ACTIVATION_SECRET);

		// Vérifier le code OTP dans Redis
		if (!redis) {
			return res.status(500).json({ message: "Redis est requis pour l'activation par OTP." });
		}
		const storedCode = await redis.get(`activation:${decoded.email}`);
		if (!storedCode || storedCode !== activationCode) {
			return res.status(400).json({ message: "Code d'activation incorrect ou expiré." });
		}

		const { nom, email, motDePasse } = decoded;
		const utilisateurExiste = await Utilisateur.findOne({ email });

		if (utilisateurExiste) {
			return res.status(400).json({ message: "Utilisateur déjà activé." });
		}

		const utilisateur = await Utilisateur.create({ nom, email, motDePasse });

		// Supprimer le code OTP après activation
		await redis.del(`activation:${email}`);

		res.status(201).json({ message: "Compte activé avec succès !" });
	} catch (error) {
		res.status(500).json({ message: error.message });
	}
};

// ✅ Connexion d'un utilisateur
exports.connexion = async (req, res) => {
	try {
		const { email, motDePasse } = req.body;

		const utilisateur = await Utilisateur.findOne({ email });
		if (!utilisateur || !(await bcrypt.compare(motDePasse, utilisateur.motDePasse))) {
			return res.status(401).json({ message: "Email ou mot de passe incorrect." });
		}

		const token = jwt.sign({ userId: utilisateur._id }, process.env.JWT_SECRET, { expiresIn: "7d" });

		// Stocker le token dans Redis
		if (redis) {
			await redis.setex(`auth:${token}`, 604800, JSON.stringify({ userId: utilisateur._id }));
		}

		res.json({
			message: "Connexion réussie",
			utilisateur,
			token,
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
		res.json({ message: "Déconnexion réussie !" });
	} catch (error) {
		res.status(500).json({ message: error.message });
	}
};

// ✅ Voir le profil d'un utilisateur
exports.voirProfil = async (req, res) => {
	try {
		const utilisateur = await Utilisateur.findById(req.params.id).populate("favoris votes");
		if (!utilisateur) return res.status(404).json({ message: "Utilisateur introuvable." });

		res.json(utilisateur);
	} catch (error) {
		res.status(500).json({ message: error.message });
	}
};

// ✅ Modifier le profil d'un utilisateur
exports.modifierProfil = async (req, res) => {
	try {
		const utilisateur = await Utilisateur.findByIdAndUpdate(req.params.id, req.body, { new: true });
		res.json(utilisateur);
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
		const { userId, tokenFCM } = req.body;
		const utilisateur = await Utilisateur.findById(userId);

		if (!utilisateur) {
			return res.status(404).json({ message: "Utilisateur introuvable." });
		}

		utilisateur.tokenFCM = tokenFCM;
		await utilisateur.save();

		res.json({ message: "Token FCM enregistré avec succès." });
	} catch (error) {
		res.status(500).json({ message: error.message });
	}
};
exports.ajouterOuRetirerFavori = async (req, res) => {
	try {
		const { id, arretId } = req.params;

		const utilisateur = await Utilisateur.findById(id);
		if (!utilisateur) return res.status(404).json({ message: "Utilisateur introuvable." });

		const index = utilisateur.favoris.indexOf(arretId);

		if (index > -1) {
			// L'arrêt est déjà en favoris, on le retire
			utilisateur.favoris.splice(index, 1);
			await utilisateur.save();
			return res.json({ message: "Arrêt retiré des favoris.", favoris: utilisateur.favoris });
		} else {
			// L'arrêt n'est pas encore en favoris, on l'ajoute
			utilisateur.favoris.push(arretId);
			await utilisateur.save();
			return res.json({ message: "Arrêt ajouté aux favoris.", favoris: utilisateur.favoris });
		}
	} catch (error) {
		res.status(500).json({ message: error.message });
	}
};
