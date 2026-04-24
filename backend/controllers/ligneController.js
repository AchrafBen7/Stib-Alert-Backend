const Ligne = require("../models/Ligne");
const Trace = require("../models/Trace");
const Arret = require("../models/Arret"); // ✅ Ajout de l'importation manquante
const Signalement = require("../models/Signalement");
const { genererAlternativeItineraire, genererResumeSignalements } = require("../config/openai");

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

		// 🧠 On récupère les signalements et on popule le champ "nom" de l’arrêt
		const signalements = await Signalement.find({ ligne: id }).populate("arretId", "nom");

		if (!signalements.length) {
			return res.json({ message: `Aucun signalement récent sur la ligne ${id}.` });
		}

		// 📝 Génération du résumé OpenAI
		const resume = await genererResumeSignalements(signalements, id, "tous les arrêts");

		// ✅ Reformater les signalements pour que arretId soit l'ID, et arretNom un champ à part
		const signalementsAvecNom = signalements.map((s) => ({
			...s.toObject(),
			arretId: s.arretId?._id?.toString() ?? s.arretId,
			arretNom: s.arretId?.nom ?? "Nom inconnu",
		}));

		res.json({ resume, signalements: signalementsAvecNom });
	} catch (error) {
		res.status(500).json({ message: error.message });
	}
};

function getLastHour() {
	const date = new Date();
	date.setHours(date.getHours() - 1);
	return date;
}

function getNearbyStopsByNom(nom) {
	return Arret.find().then((arrets) => {
		const cible = arrets.find((a) => a.nom.toLowerCase().includes(nom.toLowerCase()));
		if (!cible) return [];

		return arrets
			.map((a) => {
				const d = Math.sqrt(Math.pow(a.latitude - cible.latitude, 2) + Math.pow(a.longitude - cible.longitude, 2));
				return { ...a.toObject(), distance: d };
			})
			.sort((a, b) => a.distance - b.distance)
			.slice(0, 5);
	});
}

// ✅ Générer des alternatives en cas de perturbation
exports.voirAlternativeItineraire = async (req, res) => {
	try {
		const { depart, destination, lignesBloquees = [] } = req.body; // 👈 Pluriel ici

		const { suggestion, itineraire, details, meta } = await genererAlternativeItineraire(depart, destination, lignesBloquees); // 👈 Tableau passé

		res.json({
			depart,
			destination,
			lignesBloquees,
			suggestion,
			itineraire,
			details,
			meta,
		});
	} catch (error) {
		console.error("Erreur suggestion itinéraire:", error);
		res.status(500).json({ message: "Erreur serveur." });
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
			dateSignalement: { $gte: new Date(Date.now() - 86400000) },
		});

		// 🔹 Récupérer toutes les lignes
		const lignes = await Ligne.find().select("lineid nomComplet nomCompletRetour typeTransport couleur direction destination");

		const etatLignes = [];

		// 🔹 Initialiser chaque ligne avec ses infos de base
		const mapLignes = {}; // pour accès rapide par lineid
		lignes.forEach((ligne) => {
			mapLignes[ligne.lineid] = {
				lineid: ligne.lineid,
				nom: ligne.nomComplet,
				nomRetour: ligne.nomCompletRetour,
				typeTransport: ligne.typeTransport,
				couleur: ligne.couleur,
				direction: ligne.direction,
				destination: ligne.destination,
				incidents: 0,
				statut: "Normal",
			};
		});

		// 🔍 Compter les signalements par ligne
		signalements.forEach((s) => {
			const ligne = mapLignes[s.ligne];
			if (!ligne) return;

			ligne.incidents++;

			if (ligne.incidents >= 5) ligne.statut = "Bloqué";
			else if (ligne.incidents >= 2) ligne.statut = "Perturbé";
		});

		// 🔁 Convertir en tableau
		Object.values(mapLignes).forEach((etat) => {
			etatLignes.push(etat);
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
