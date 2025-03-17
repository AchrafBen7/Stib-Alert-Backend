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

		// ✅ Vérifier si tous les types fournis sont valides
		const typesValides = ["Tram", "Bus", "Métro"];
		const typesFiltres = typeTransport.filter((t) => typesValides.includes(t));

		if (typesFiltres.length === 0) {
			return res.status(400).json({ message: "Type de transport invalide." });
		}

		// ✅ Générer un stop_id unique basé sur le nom (ex: "Vanderkindere" → "VAND001")
		const stopIdBase = nom.toUpperCase().replace(/\s+/g, "").slice(0, 6); // Ex: VANDER
		const stopIdUnique = stopIdBase + Math.floor(100 + Math.random() * 900); // Ex: "VAND123"

		const nouvelArret = new Arret({
			stop_id: stopIdUnique, // ✅ Ajout du stop_id généré
			nom,
			latitude,
			longitude,
			typeTransport: typesFiltres,
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

		if (!arret) return res.status(404).json({ message: "Arrêt introuvable." });
		if (!ligne) return res.status(404).json({ message: "Ligne introuvable." });

		// Vérifier si la ligne correspond au type de transport de l'arrêt
		if (!arret.typeTransport.includes(ligne.typeTransport)) {
			return res.status(400).json({
				message: `L'arrêt ${arret.nom} ne prend pas en charge le type ${ligne.typeTransport}.`,
			});
		}

		// ✅ Ajouter la ligne à l'arrêt
		if (!arret.lignesDesservies.includes(ligne.lineid)) {
			arret.lignesDesservies.push(ligne.lineid);
			await arret.save();
		}

		// ✅ Ajouter l'arrêt à la ligne
		if (!ligne.points.some((point) => point.id.toString() === arret._id.toString())) {
			ligne.points.push({ id: arret._id, order: ligne.points.length + 1 });
			await ligne.save();
		}

		res.json({ message: "Arrêt et ligne synchronisés avec succès.", arret, ligne });
	} catch (error) {
		res.status(500).json({ message: error.message });
	}
};

exports.ajouterLigneAArrêt = async (req, res) => {
	try {
		const { arretId, ligneId } = req.params;

		// 🔍 Vérifier si l'arrêt et la ligne existent
		const arret = await Arret.findById(arretId);
		const ligne = await Ligne.findById(ligneId);

		if (!arret) {
			return res.status(404).json({ message: "Arrêt introuvable." });
		}
		if (!ligne) {
			return res.status(404).json({ message: "Ligne introuvable." });
		}

		// ✅ Vérifier si la ligne correspond à un type de transport pris en charge par l'arrêt
		if (!arret.typeTransport.includes(ligne.typeTransport)) {
			return res.status(400).json({
				message: `L'arrêt ${arret.nom} ne prend pas en charge le type ${ligne.typeTransport}.`,
			});
		}

		// ✅ Ajouter la ligne si elle n'est pas déjà présente
		if (!arret.lignesDesservies.includes(ligne.lineid)) {
			arret.lignesDesservies.push(ligne.lineid);
			await arret.save();
		}

		res.json({
			message: `Ligne ${ligne.lineid} ajoutée à l'arrêt ${arret.nom} avec succès.`,
			arret,
		});
	} catch (error) {
		res.status(500).json({ message: error.message });
	}
};
