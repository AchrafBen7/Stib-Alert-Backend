const Signalement = require("../models/Signalement");
const Arret = require("../models/Arret");
const { analyserSignalement, genererResumeSignalements, traduireSignalement } = require("../config/openai");
const { emitSignalement } = require("../config/websocket");
const moment = require("moment");

// 🔹 Fonction pour calculer la distance entre deux points (en km)
const distanceEntrePoints = (lat1, lon1, lat2, lon2) => {
	const R = 6371; // Rayon de la Terre en km
	const dLat = (lat2 - lat1) * (Math.PI / 180);
	const dLon = (lon2 - lon1) * (Math.PI / 180);
	const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
	const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
	return R * c;
};

exports.ajouterSignalement = async (req, res) => {
	try {
		const { nomArret, ligne, typeProbleme, description, photo, latitude, longitude } = req.body;
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
			const distance = distanceEntrePoints(latitude, longitude, arret.latitude, arret.longitude);
			if (distance < 0.2) confiance = "haute"; // ✅ Moins de 200m → Fiable
			else if (distance < 1) confiance = "moyenne"; // 🤔 Entre 200m et 1km → Acceptable
		}

		// 🔹 Création du signalement avec "confiance"
		const signalement = await Signalement.create({
			arretId: arret._id,
			ligne,
			typeProbleme,
			description,
			photo,
			confiance, // ✅ Niveau de confiance du signalement
		});

		// 🚀 Émettre le signalement en temps réel via WebSockets
		emitSignalement(signalement);
		// ✅ Formatter la date avant d'envoyer la réponse
		signalement.dateSignalement = moment(signalement.dateSignalement).format("YYYY-MM-DD HH:mm");

		res.status(201).json({ message: "Signalement ajouté avec succès.", signalement });
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

		// Rechercher un seul signalement qui a l'ID 'signalementId' et un 'arretId' égal à arretId
		const signalement = await Signalement.findOne({ _id: signalementId, arretId }).populate("arretId");
		if (!signalement) {
			return res.status(404).json({ message: "Signalement introuvable pour cet arrêt." });
		}

		// Vous pouvez formater la réponse comme vous voulez
		res.json({
			id: signalement._id,
			ligne: signalement.ligne,
			typeProbleme: signalement.typeProbleme,
			description: signalement.description,
			photo: signalement.photo,
			date: signalement.dateSignalement,
			arret: arret.nom,
		});
	} catch (error) {
		res.status(500).json({ message: error.message });
	}
};

// ✅ Ajout de la pagination (optionnelle)
exports.voirSignalements = async (req, res) => {
	try {
		const signalements = await Signalement.find().populate("arretId");
		res.json(signalements);
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
		const signalements = await Signalement.find({ arretId: req.params.id }).populate("arretId");

		// 🔹 Générer le résumé
		const resume = await genererResumeSignalements(signalements, arret.nom, signalements.length > 0 ? signalements[0].ligne : "N/A");

		res.json({
			resume,
			signalements: signalements.map((s) => ({
				id: s._id,
				ligne: s.ligne,
				typeProbleme: s.typeProbleme,
				description: s.description,
				photo: s.photo,
				date: s.dateSignalement,
				arret: arret.nom, // ✅ Correction ici pour bien afficher l'arrêt
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

		if (vote === "up") {
			signalement.votesPositifs += 1;
		} else if (vote === "down") {
			signalement.votesNegatifs += 1;
		}

		await signalement.save();

		// Si un signalement reçoit trop de votes négatifs, il est marqué comme suspect
		if (signalement.votesNegatifs >= 5) {
			await Signalement.findByIdAndUpdate(signalement._id, { confiance: "basse" });
		}

		res.json({ message: "Vote enregistré !" });
	} catch (error) {
		res.status(500).json({ message: error.message });
	}
};

exports.signalerFauxSignalement = async (req, res) => {
	try {
		const signalement = await Signalement.findById(req.params.id);

		if (!signalement) return res.status(404).json({ message: "Signalement introuvable" });

		// 🔹 Incrémentation des signalements
		signalement.signalements += 1;
		await signalement.save();

		// 🚨 Si un signalement est marqué comme faux 7 fois, il est supprimé
		if (signalement.signalements >= 7) {
			await Signalement.findByIdAndDelete(signalement._id);
			return res.json({ message: "🚨 Ce signalement a été supprimé car trop de personnes l'ont signalé comme faux." });
		}

		// ⚠️ Si signalé 3 fois, on abaisse sa confiance
		if (signalement.signalements >= 3) {
			signalement.confiance = "basse";
			await signalement.save();
		}

		res.json({ message: "✅ Signalement signalé comme faux." });
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

exports.traduireSignalement = async (req, res) => {
	try {
		const { id } = req.params; // ID du signalement à traduire
		const signalement = await Signalement.findById(id);

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
