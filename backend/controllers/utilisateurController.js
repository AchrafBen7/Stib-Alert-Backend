const Utilisateur = require("../models/Utilisateur");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const redis = require("../config/redis");
const sendMail = require("../config/Mail");
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
		await redis.setex(`auth:${token}`, 604800, JSON.stringify({ userId: utilisateur._id }));

		res.json({
			message: "Connexion réussie",
			utilisateur,
			token,
		});
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
