const Arret = require("../models/Arret");
const Ligne = require("../models/Ligne");
const Signalement = require("../models/Signalement");

function haversineMeters(lat1, lng1, lat2, lng2) {
	const R = 6371000;
	const dLat = ((lat2 - lat1) * Math.PI) / 180;
	const dLng = ((lng2 - lng1) * Math.PI) / 180;
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
	return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Filtre défensif : des arrêts de test (« Test Stop 12 », créés en dev) peuvent
// traîner dans la base et polluaient l'onboarding + la recherche côté app. On
// ne les renvoie jamais dans les endpoints de lecture.
const TEST_STOP_REGEX = /\btest\b/i;
function isTestStop(nom) {
	return TEST_STOP_REGEX.test(String(nom || ""));
}

exports.arretsProches = async (req, res) => {
	try {
		const lat = parseFloat(req.query.lat);
		const lng = parseFloat(req.query.lng);
		const radius = parseFloat(req.query.radius) || 600;

		if (isNaN(lat) || isNaN(lng)) {
			return res.status(400).json({ message: "lat et lng sont requis." });
		}

		const arrets = (await Arret.find().lean()).filter((a) => !isTestStop(a.nom));

		const avecDistance = arrets
			.map((a) => ({ ...a, distance: haversineMeters(lat, lng, a.latitude, a.longitude) }))
			.filter((a) => a.distance <= radius)
			.sort((a, b) => a.distance - b.distance)
			.slice(0, 10);

		const enrichis = await Promise.all(
			avecDistance.map(async (arret) => {
				const lignes = await Ligne.find({ lineid: { $in: arret.lignesDesservies } }).lean();
				return {
					_id: arret._id,
					nom: arret.nom,
					latitude: arret.latitude,
					longitude: arret.longitude,
					distanceMeters: Math.round(arret.distance),
					lignes: lignes.map((l) => ({
						lineid: l.lineid,
						typeTransport: l.typeTransport,
						couleur: l.couleur,
						destination: l.destination,
					})),
				};
			})
		);

		res.json(enrichis);
	} catch (error) {
		res.status(500).json({ message: error.message });
	}
};
// ✅ Recherche d'arrêts par nom OU numéro de ligne, sur TOUT le réseau.
// Avant, l'ajout d'un favori ne montrait que les arrêts dans 1,5 km de
// l'utilisateur (via /nearby) : impossible d'épingler un arrêt éloigné comme
// "Paduwa" (bus 66). Cet endpoint répond avec la MÊME forme que /nearby pour
// que le DTO client (ArretNearbyDTO) décode sans changement. distanceMeters
// vaut 0 (pas de point d'origine).
exports.rechercheArrets = async (req, res) => {
	try {
		const q = (req.query.q || "").trim();
		if (q.length < 2) {
			return res.json([]);
		}

		// Accent-insensible : on échappe la regex puis on tolère les variantes
		// accentuées des voyelles (e≈éèêë, a≈àâ, …) pour que "paduwa" matche
		// "Paduwa" et "metro" matche "Métro".
		const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const accentTolerant = escaped
			.replace(/[eéèêë]/gi, "[eéèêë]")
			.replace(/[aàâä]/gi, "[aàâä]")
			.replace(/[iîï]/gi, "[iîï]")
			.replace(/[oôö]/gi, "[oôö]")
			.replace(/[uùûü]/gi, "[uùûü]")
			.replace(/[cç]/gi, "[cç]");
		const nameRegex = new RegExp(accentTolerant, "i");

		// Match par nom d'arrêt OU par ligne desservie (ex: "66").
		// On exclut les arrêts de test directement dans la requête.
		const arrets = await Arret.find({
			$and: [
				{ $or: [{ nom: nameRegex }, { lignesDesservies: q.toUpperCase() }] },
				{ nom: { $not: TEST_STOP_REGEX } },
			],
		})
			.limit(25)
			.lean();

		const enrichis = await Promise.all(
			arrets.map(async (arret) => {
				const lignes = await Ligne.find({ lineid: { $in: arret.lignesDesservies } }).lean();
				return {
					_id: arret._id,
					nom: arret.nom,
					latitude: arret.latitude,
					longitude: arret.longitude,
					distanceMeters: 0,
					lignes: lignes.map((l) => ({
						lineid: l.lineid,
						typeTransport: l.typeTransport,
						couleur: l.couleur,
						destination: l.destination,
					})),
				};
			})
		);

		// Les correspondances exactes de nom d'abord, puis alphabétique.
		const qLower = q.toLowerCase();
		enrichis.sort((a, b) => {
			const aExact = a.nom.toLowerCase().startsWith(qLower) ? 0 : 1;
			const bExact = b.nom.toLowerCase().startsWith(qLower) ? 0 : 1;
			if (aExact !== bExact) return aExact - bExact;
			return a.nom.localeCompare(b.nom);
		});

		res.json(enrichis);
	} catch (error) {
		res.status(500).json({ message: error.message });
	}
};

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

		if (!arret.lignesDesservies.includes(ligne.lineid)) {
			arret.lignesDesservies.push(ligne.lineid);
		}

		// ✅ Ajouter l'arrêt à la ligne
		if (!ligne.points.some((point) => point.id.toString() === arret._id.toString())) {
			const nouvelOrdre = ligne.points.length + 1;
			ligne.points.push({ id: arret._id, order: nouvelOrdre });
			await ligne.save();

			// ✅ Ajouter ou mettre à jour l'ordre dans l'arrêt
			if (!arret.order) {
				arret.order = {};
			}
			arret.order[ligne.lineid] = nouvelOrdre;
		}

		// ✅ Sauvegarder l'arrêt mis à jour
		await arret.save();

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
		// Exclut les arrêts de test (sinon ils entrent dans le catalogue client).
		const arrets = await Arret.find({ nom: { $not: TEST_STOP_REGEX } });
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
			const aOrder = a.order?.[line] ?? 9999;
			const bOrder = b.order?.[line] ?? 9999;
			return sort === "desc" ? bOrder - aOrder : aOrder - bOrder;
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

				// 🔥 Convertir toutes les dates ISO
				const signalementsFormatted = signalements.map((s) => ({
					...s,
					dateSignalement: (s.dateSignalement instanceof Date ? s.dateSignalement : new Date(s.dateSignalement)).toISOString().split(".")[0] + "Z",
				}));

				// 🔥 Calcul dynamique de l’état
				let etat = "Vert";
				if (signalements.length >= 4) etat = "Rouge";
				else if (signalements.length >= 2) etat = "Orange";

				// ✅ (Optionnel) Persister dans Mongo si tu veux le stocker
				await Arret.findByIdAndUpdate(arret._id, { etat });

				return {
					...arret,
					etat,
					signalementsRecents: signalementsFormatted,
				};
			})
		);
		const arretsFinal = arretsAvecInfos.map((arret) => {
			let orderClean = {};
			if (arret.order && typeof arret.order === "object") {
				for (const [k, v] of Object.entries(arret.order)) {
					orderClean[k] = typeof v === "object" && v.hasOwnProperty("$numberInt") ? parseInt(v.$numberInt) : v;
				}
			}

			return {
				...arret,
				typeTransport: Array.isArray(arret.typeTransport) ? arret.typeTransport : [arret.typeTransport],
				order: orderClean,
				signalementsRecents: arret.signalementsRecents, // ✅ ne PAS l'oublier ici !
			};
		});

		res.json(arretsFinal);
	} catch (error) {
		console.error("[ERREUR] voirArretsParLigneFiltres:", error);
		res.status(500).json({ message: error.message });
	}
};
