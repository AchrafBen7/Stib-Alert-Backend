const Utilisateur = require("../models/Utilisateur");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

// ✅ Inscription d'un utilisateur
exports.inscription = async (req, res) => {
	try {
		const { nom, email, motDePasse } = req.body;

		const utilisateurExiste = await Utilisateur.findOne({ email });
		if (utilisateurExiste) {
			return res.status(400).json({ message: "Cet email est déjà utilisé." });
		}

		const hashedPassword = await bcrypt.hash(motDePasse, 10);
		const utilisateur = await Utilisateur.create({ nom, email, motDePasse: hashedPassword });

		res.status(201).json({
			message: "Inscription réussie",
			utilisateur,
			token: jwt.sign({ userId: utilisateur._id }, process.env.JWT_SECRET, { expiresIn: "7d" }),
		});
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

		res.json({
			message: "Connexion réussie",
			utilisateur,
			token: jwt.sign({ userId: utilisateur._id }, process.env.JWT_SECRET, { expiresIn: "7d" }),
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
