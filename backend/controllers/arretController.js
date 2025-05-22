const Arret = require("../models/Arret");
const Ligne = require("../models/Ligne");
const Signalement = require("../models/Signalement");
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

exports.voirLignesPourArret = async (req, res) => {
	const arretId = req.params.id;

	try {
		const arret = await Arret.findById(arretId);

		if (!arret) {
			return res.status(404).json({ message: "Arrêt non trouvé" });
		}

		// Supposons que arret.lignesDesservies est un tableau de lineid
		const lignes = await Ligne.find({ lineid: { $in: arret.lignesDesservies } });

		res.json(lignes);
	} catch (error) {
		console.error("[ERREUR] Backend voirLignesPourArret :", error);
		res.status(500).json({ message: "Erreur serveur" });
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
exports.voirTousLesArrets = async (req, res) => {
	try {
		const arrets = await Arret.find();
		res.json(arrets);
	} catch (error) {
		res.status(500).json({ message: error.message });
	}
};
exports.voirArretsParLigne = async (req, res) => {
	try {
		const { line } = req.query; // Par exemple, ?line=7
		if (!line) {
			return res.status(400).json({ message: "Le paramètre 'line' est requis." });
		}

		// On cherche tous les arrêts dont le tableau "lignesDesservies" contient la valeur "line"
		const arrets = await Arret.find({ lignesDesservies: line });
		res.json(arrets);
	} catch (error) {
		res.status(500).json({ message: error.message });
	}
};
exports.voirArretsParLigneFiltres = async (req, res) => {
	try {
		const { line, sort } = req.query;
		if (!line) return res.status(400).json({ message: "Paramètre 'line' requis." });

		let arrets = await Arret.find({ lignesDesservies: line }).lean();

		// Coordonnées de tri (exemple statique — adapter si besoin)
		const latA = 50.896804,
			lonA = 4.337345;
		const latB = 50.813378,
			lonB = 4.348149;
		const dx = lonB - lonA,
			dy = latB - latA;
		const denom = dx * dx + dy * dy;

		// Tri
		arrets.sort((a, b) => {
			const projA = ((a.latitude - latA) * dy + (a.longitude - lonA) * dx) / denom;
			const projB = ((b.latitude - latA) * dy + (b.longitude - lonA) * dx) / denom;
			return sort === "desc" ? projB - projA : projA - projB;
		});

		// Signalements récents
		const now = new Date();
		const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

		const arretsAvecInfos = await Promise.all(
			arrets.map(async (arret) => {
				const signalements = await Signalement.find({
					arretId: arret._id,
					dateSignalement: { $gte: oneDayAgo },
				}).lean();

				// 🔥 Calcul dynamique de l’état
				let etat = "Vert";
				if (signalements.length >= 4) etat = "Rouge";
				else if (signalements.length >= 2) etat = "Orange";

				// ✅ (Optionnel) Persister dans Mongo si tu veux le stocker
				await Arret.findByIdAndUpdate(arret._id, { etat });

				return {
					...arret,
					etat,
					signalementsRecents: signalements,
				};
			})
		);

		res.json(arretsAvecInfos);
	} catch (error) {
		console.error("[ERREUR] voirArretsParLigneFiltres:", error);
		res.status(500).json({ message: error.message });
	}
};
