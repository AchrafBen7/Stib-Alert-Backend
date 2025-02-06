const Ligne = require("../models/Ligne");
const Trace = require("../models/Trace");
const Signalement = require("../models/Signalement");
const { genererSuggestionAlternative, genererResumeSignalements } = require("../config/openai");

// ✅ Récupérer le tracé d’une ligne spécifique
exports.voirTraceParLigne = async (req, res) => {
	try {
		const ligne = await Ligne.findOne({ lineid: req.params.id });

		if (!ligne) return res.status(404).json({ message: "Ligne introuvable" });

		const trace = await Trace.findOne({ ligneId: ligne._id });

		if (!trace) return res.status(404).json({ message: "Tracé introuvable" });

		res.json(trace);

		if (!trace) return res.status(404).json({ message: "Tracé introuvable" });
		res.json(trace);
	} catch (error) {
		res.status(500).json({ message: error.message });
	}
};
// ✅ Obtenir toutes les lignes
exports.voirToutesLesLignes = async (req, res) => {
	try {
		const lignes = await Ligne.find().select("lineid nomComplet typeTransport couleur direction");
		res.json(lignes);
	} catch (error) {
		res.status(500).json({ message: error.message });
	}
};

// ✅ Voir toutes les perturbations sur une ligne spécifique
exports.voirPerturbationsParLigne = async (req, res) => {
	try {
		const { id } = req.params;
		const signalements = await Signalement.find({ ligne: id });

		if (!signalements.length) {
			return res.json({ message: `Aucun signalement récent sur la ligne ${id}.` });
		}

		// 🔹 Génération d’un résumé OpenAI des perturbations
		const resume = await genererResumeSignalements(signalements, id, "tous les arrêts");

		res.json({ resume, signalements });
	} catch (error) {
		res.status(500).json({ message: error.message });
	}
};

// ✅ Générer des alternatives en cas de perturbation
exports.genererAlternatives = async (req, res) => {
	try {
		const { ligne, arret } = req.params;

		// Trouver les lignes alternatives desservant cet arrêt
		const arretData = await Arret.findOne({ nom: arret });
		const alternatives = arretData ? arretData.lignesDesservies.filter((l) => l !== ligne) : [];

		// 🔹 Génération de la suggestion OpenAI
		const suggestion = await genererSuggestionAlternative(ligne, arret, alternatives);

		res.json({ suggestion, alternatives });
	} catch (error) {
		res.status(500).json({ message: error.message });
	}
};
