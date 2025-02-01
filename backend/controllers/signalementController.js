const Signalement = require("../models/Signalement");
const Arret = require("../models/Arret");
const { analyserSignalement } = require("../config/openai");

exports.ajouterSignalement = async (req, res) => {
	try {
		const { arretId, ligne, typeProbleme, description, photo } = req.body;

		// Vérification IA pour éviter le spam / fake news
		const estValide = await analyserSignalement(description);
		if (!estValide) {
			return res.status(400).json({ message: "Ce signalement ne respecte pas les règles." });
		}

		const signalement = await Signalement.create({
			arretId,
			ligne,
			typeProbleme,
			description,
			photo,
		});

		res.status(201).json({ message: "Signalement ajouté et en cours de traitement.", signalement });
	} catch (error) {
		res.status(400).json({ message: error.message });
	}
};

// ✅ Ajout de la pagination (optionnelle)
exports.voirSignalements = async (req, res) => {
	try {
		const { page = 1, limit = 10 } = req.query;
		const signalements = await Signalement.find()
			.populate("arretId")
			.limit(limit * 1) // Convertit en nombre
			.skip((page - 1) * limit);

		res.json(signalements);
	} catch (error) {
		res.status(500).json({ message: error.message });
	}
};

// ✅ Voir les signalements d’un arrêt spécifique
exports.voirSignalementsParArret = async (req, res) => {
	try {
		const signalements = await Signalement.find({ arretId: req.params.id });
		res.json(signalements);
	} catch (error) {
		res.status(500).json({ message: error.message });
	}
};

// ✅ Fonction pour voter pour un signalement
exports.voterSignalement = async (req, res) => {
	try {
		const signalement = await Signalement.findById(req.params.id);
		if (!signalement) return res.status(404).json({ message: "Signalement introuvable" });

		signalement.votes += 1;
		await signalement.save();
		res.json({ message: "Vote ajouté !" });
	} catch (error) {
		res.status(500).json({ message: error.message });
	}
};

// ✅ Voir toutes les lignes ayant des signalements
exports.voirLignesDisponibles = async (req, res) => {
	try {
		const lignes = await Signalement.distinct("ligne");
		res.json(lignes);
	} catch (error) {
		res.status(500).json({ message: error.message });
	}
};

// ✅ Voir tous les arrêts d’une ligne spécifique
exports.voirArretsParLigne = async (req, res) => {
	try {
		const { ligne } = req.params;
		const arrets = await Arret.find({ lignesDesservies: ligne });
		res.json(arrets);
	} catch (error) {
		res.status(500).json({ message: error.message });
	}
};

// ✅ Voir les signalements d’un arrêt spécifique pour une ligne
exports.voirSignalementsParLigneEtArret = async (req, res) => {
	try {
		const { ligne, arretId } = req.params;
		const signalements = await Signalement.find({ ligne, arretId }).populate("arretId");
		res.json(signalements);
	} catch (error) {
		res.status(500).json({ message: error.message });
	}
};
