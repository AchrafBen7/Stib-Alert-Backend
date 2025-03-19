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
// Dans votre ligneController.js
exports.voirToutesLesLignesDisponibles = async (req, res) => {
	try {
		// On récupère TOUTES les lignes, sans condition spécifique
		const lignes = await Ligne.find();
		res.json(lignes);
	} catch (error) {
		res.status(500).json({ message: error.message });
	}
};
// Ajouter ou mettre à jour le champ nomCompletRetour pour une ligne donnée
exports.ajouterNomCompletRetour = async (req, res) => {
	try {
		// On suppose que l'identifiant de la ligne est passé dans l'URL (par exemple, _id)
		const { id } = req.params;
		const { nomCompletRetour } = req.body;

		if (!nomCompletRetour) {
			return res.status(400).json({ message: "Le nomCompletRetour est requis." });
		}

		// Met à jour la ligne en ajoutant le champ nomCompletRetour
		const updatedLigne = await Ligne.findByIdAndUpdate(id, { nomCompletRetour }, { new: true });

		if (!updatedLigne) {
			return res.status(404).json({ message: "Ligne non trouvée." });
		}

		res.json({
			message: "nomCompletRetour ajouté avec succès.",
			ligne: updatedLigne,
		});
	} catch (error) {
		res.status(500).json({ message: error.message });
	}
};

// ✅ Obtenir toutes les lignes
exports.voirToutesLesLignes = async (req, res) => {
	try {
		const lignes = await Ligne.find().select("lineid nomComplet nomCompletRetour typeTransport couleur direction");
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
exports.voirArretsParLigne = async (req, res) => {
	try {
		const { lineid } = req.params;

		// On recherche la ligne par son "lineid"
		const ligne = await Ligne.findOne({ lineid }).populate("points.id");
		if (!ligne) {
			return res.status(404).json({ message: "Ligne non trouvée." });
		}

		// Trier les points par ordre (order)
		const pointsTries = ligne.points.sort((a, b) => a.order - b.order);

		// Extraire les arrêts à partir des points
		const arrets = pointsTries.map((point) => point.id);

		res.json(arrets);
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
exports.ajouterArretALigne = async (req, res) => {
	try {
		const { lineid } = req.params; // ID de la ligne (exemple: "7")
		const { arretId, order } = req.body; // ID de l'arrêt et ordre optionnel

		// Vérifier que la ligne existe
		const ligne = await Ligne.findOne({ lineid });
		if (!ligne) {
			return res.status(404).json({ message: "Ligne non trouvée." });
		}

		// Vérifier que l'arrêt existe
		const arret = await Arret.findById(arretId);
		if (!arret) {
			return res.status(404).json({ message: "Arrêt non trouvé." });
		}

		// Vérifier si cet arrêt est déjà associé à la ligne
		if (ligne.points.some((point) => point.id.toString() === arretId)) {
			return res.status(400).json({ message: "Cet arrêt est déjà associé à cette ligne." });
		}

		// Déterminer l'ordre : si non fourni, on ajoute à la fin (dernier + 1)
		const orderFinal = order || ligne.points.length + 1;

		// Créer le nouvel objet point
		const nouveauPoint = { id: arretId, order: orderFinal };

		// Ajouter le point à la ligne
		ligne.points.push(nouveauPoint);
		await ligne.save();

		res.status(200).json({
			message: "Arrêt ajouté à la ligne avec succès.",
			ligne,
		});
	} catch (error) {
		res.status(500).json({ message: error.message });
	}
};
exports.majOrderPourLigne = async (req, res) => {
	try {
		const { line, sort } = req.query;
		if (!line) {
			return res.status(400).json({ message: "Le paramètre 'line' est requis." });
		}

		// Vérifier que la ligne existe dans la collection Ligne
		const Ligne = require("../models/Ligne");
		const ligne = await Ligne.findOne({ lineid: line });
		if (!ligne) {
			return res.status(404).json({ message: "Ligne introuvable." });
		}

		// Récupérer tous les arrêts qui desservent cette ligne
		const Arret = require("../models/Arret");
		const arrets = await Arret.find({ lignesDesservies: line });

		// Coordonnées des deux terminus (à adapter selon la ligne et le sens souhaité)
		const latA = 50.896804,
			lonA = 4.337345; // Par exemple, terminus de départ (HEYSEL)
		const latB = 50.813378,
			lonB = 4.348149; // Par exemple, terminus d'arrivée (VANDERKINDERE)
		const dx = lonB - lonA,
			dy = latB - latA;
		const denom = dx * dx + dy * dy;

		// Trier les arrêts par projection sur la trajectoire définie par les deux terminus
		arrets.sort((a, b) => {
			const projA = ((a.latitude - latA) * dy + (a.longitude - lonA) * dx) / denom;
			const projB = ((b.latitude - latA) * dy + (b.longitude - lonA) * dx) / denom;
			return sort === "desc" ? projB - projA : projA - projB;
		});

		// Mettre à jour le champ d'ordre pour chaque arrêt
		for (let i = 0; i < arrets.length; i++) {
			await Arret.findByIdAndUpdate(arrets[i]._id, {
				$set: { [`order.${line}`]: i + 1 },
			});
		}

		res.json({ message: `Order mis à jour pour la ligne ${line}`, count: arrets.length });
	} catch (error) {
		res.status(500).json({ message: error.message });
	}
};
