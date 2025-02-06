const Signalement = require("../models/Signalement");
const Arret = require("../models/Arret");
const { analyserSignalement, genererResumeSignalements, traduireSignalement } = require("../config/openai");

exports.ajouterSignalement = async (req, res) => {
	try {
		const { nomArret, ligne, typeProbleme, description, photo } = req.body;
		let arret = await Arret.findOne({ nom: nomArret });

		if (!arret) return res.status(404).json({ message: `L'arrêt "${nomArret}" n'existe pas.` });

		if (!arret.lignesDesservies.includes(ligne)) {
			return res.status(400).json({ message: `L'arrêt "${nomArret}" ne dessert pas la ligne "${ligne}".` });
		}

		// 🔹 Vérification OpenAI pour éviter le spam
		const estValide = await analyserSignalement(description);
		if (!estValide) return res.status(400).json({ message: "Ce signalement ne respecte pas les règles." });

		// 🔹 Création du signalement sans traduction stockée
		const signalement = await Signalement.create({
			arretId: arret._id,
			ligne,
			typeProbleme,
			description, // ✅ On stocke uniquement le texte original
			photo,
		});

		res.status(201).json({ message: "Signalement ajouté avec succès.", signalement });
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
		const signalement = await Signalement.findById(req.params.id);
		if (!signalement) return res.status(404).json({ message: "Signalement introuvable" });

		// Vérifie si l'utilisateur est connecté
		if (!req.user) {
			return res.status(401).json({ message: "Vous devez être connecté pour voter." });
		}

		const utilisateur = await Utilisateur.findById(req.user.userId);
		if (!utilisateur) return res.status(404).json({ message: "Utilisateur introuvable" });

		// Vérifie si l'utilisateur a déjà voté pour ce signalement
		if (utilisateur.votes.includes(signalement._id)) {
			return res.status(400).json({ message: "Vous avez déjà voté pour ce signalement." });
		}

		// Ajoute le signalement à la liste des votes de l'utilisateur
		utilisateur.votes.push(signalement._id);
		await utilisateur.save();

		// Augmente le nombre de votes sur le signalement
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
exports.supprimerSignalement = async (req, res) => {
	try {
		const signalement = await Signalement.findById(req.params.id);

		if (!signalement) return res.status(404).json({ message: "Signalement introuvable" });

		// Vérifier si l'utilisateur est bien l'auteur du signalement
		if (signalement.utilisateurId.toString() !== req.user.userId) {
			return res.status(403).json({ message: "Vous ne pouvez pas supprimer ce signalement." });
		}

		await signalement.deleteOne();
		res.json({ message: "Signalement supprimé avec succès." });
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
