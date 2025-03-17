const Ligne = require("../models/Ligne");
const Trace = require("../models/Trace");
const Arret = require("../models/Arret"); // ✅ Ajout de l'importation manquante
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
exports.voirLigneParLineID = async (req, res) => {
	try {
		const ligne = await Ligne.findOne({ lineid: req.params.lineid });

		if (!ligne) {
			return res.status(404).json({ message: "Ligne introuvable." });
		}

		res.json(ligne);
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
exports.voirAlternatives = async (req, res) => {
	try {
		const { lineid, arretId } = req.params;

		// ✅ Vérifier si l'arrêt existe
		const arret = await Arret.findById(arretId);
		if (!arret) return res.status(404).json({ message: "Arrêt introuvable." });

		// ✅ Trouver les autres lignes qui passent par cet arrêt
		const alternatives = arret.lignesDesservies.filter((id) => id !== lineid);

		// ✅ Générer une suggestion avec OpenAI
		const suggestion = await genererSuggestionAlternative(lineid, arret.nom, alternatives);

		res.json({
			arret: arret.nom,
			ligneAffectee: lineid,
			alternatives,
			suggestion,
		});
	} catch (error) {
		res.status(500).json({ message: error.message });
	}
};

exports.etatLignes = async (req, res) => {
	try {
		// 🔍 Récupérer les signalements récents (dernières 24h)
		const signalements = await Signalement.find({
			dateSignalement: { $gte: new Date(Date.now() - 86400000) }, // ➜ Étendre à 24h
		});

		// 🔹 Récupérer toutes les lignes de la base de données
		const lignes = await Ligne.find().select("lineid nomComplet");

		const etatLignes = {};

		// 🔹 Initialiser toutes les lignes à "Normal"
		lignes.forEach((ligne) => {
			etatLignes[ligne.lineid] = { nom: ligne.nomComplet, incidents: 0, statut: "Normal" };
		});

		// 🔍 Analyser les signalements
		signalements.forEach((s) => {
			if (!etatLignes[s.ligne]) return; // ➜ Si la ligne n'existe pas, on l'ignore

			etatLignes[s.ligne].incidents++;

			if (etatLignes[s.ligne].incidents >= 5) etatLignes[s.ligne].statut = "Bloqué";
			else if (etatLignes[s.ligne].incidents >= 2) etatLignes[s.ligne].statut = "Perturbé";
		});

		res.json(etatLignes);
	} catch (error) {
		res.status(500).json({ message: error.message });
	}
};
