const Arret = require("../models/Arret");
const Ligne = require("../models/Ligne");

// ✅ 1. Créer un nouvel arrêt (ex: Vanderkindere)
exports.ajouterArret = async (req, res) => {
	try {
		const { nom, latitude, longitude, typeTransport } = req.body;

		// Vérifier si l'arrêt existe déjà
		const arretExiste = await Arret.findOne({ nom });
		if (arretExiste) {
			return res.status(400).json({ message: "Cet arrêt existe déjà." });
		}

		const nouvelArret = new Arret({
			nom,
			latitude,
			longitude,
			typeTransport,
			lignesDesservies: [],
		});

		await nouvelArret.save();
		res.status(201).json({ message: "Arrêt ajouté avec succès.", arret: nouvelArret });
	} catch (error) {
		res.status(500).json({ message: error.message });
	}
};

// ✅ 2. Créer une nouvelle ligne (ex: Tram 7)
exports.ajouterLigne = async (req, res) => {
	try {
		const { lineid, nomComplet, typeTransport, couleur } = req.body;

		// Vérifier si la ligne existe déjà
		const ligneExiste = await Ligne.findOne({ lineid });
		if (ligneExiste) {
			return res.status(400).json({ message: "Cette ligne existe déjà." });
		}

		const nouvelleLigne = new Ligne({
			lineid,
			nomComplet,
			typeTransport,
			couleur,
			destination: { fr: nomComplet, nl: "Te bepalen" },
			direction: "City",
			points: [],
		});

		await nouvelleLigne.save();
		res.status(201).json({ message: "Ligne ajoutée avec succès.", ligne: nouvelleLigne });
	} catch (error) {
		res.status(500).json({ message: error.message });
	}
};

// ✅ 3. Synchroniser un arrêt avec une ligne
exports.synchroniserArretAvecLigne = async (req, res) => {
	try {
		const { arretId, ligneId } = req.params;

		// Vérifier si l'arrêt et la ligne existent
		const arret = await Arret.findById(arretId);
		const ligne = await Ligne.findById(ligneId);

		if (!arret) {
			return res.status(404).json({ message: "Arrêt introuvable." });
		}
		if (!ligne) {
			return res.status(404).json({ message: "Ligne introuvable." });
		}

		// Ajouter la ligne à l'arrêt si elle n'est pas déjà associée
		if (!arret.lignesDesservies.includes(ligne.lineid)) {
			arret.lignesDesservies.push(ligne.lineid);
			await arret.save();
		}

		// Ajouter l'arrêt à la ligne si ce n'est pas déjà fait
		if (!ligne.points.some((point) => point.id.toString() === arret._id.toString())) {
			ligne.points.push({ id: arret._id, order: ligne.points.length + 1 });
			await ligne.save();
		}

		res.json({ message: "Arrêt et ligne synchronisés avec succès.", arret, ligne });
	} catch (error) {
		res.status(500).json({ message: error.message });
	}
};
