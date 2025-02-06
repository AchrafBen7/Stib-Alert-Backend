const mongoose = require("mongoose");
const fs = require("fs");
require("dotenv").config();
const Arret = require("../models/Arret");

mongoose.connect(process.env.MONGO_URI, {
	autoIndex: false,
});

const importArrets = async () => {
	try {
		console.log("🚀 Importation des Arrêts...");

		// 🔹 Lire stops.txt
		const rawStops = fs.readFileSync("./stops.txt", "utf-8").trim();
		const arretsRows = rawStops.split("\n").slice(1);
		const arrets = [];

		for (const row of arretsRows) {
			const stop = row.split(",");

			if (stop.length < 6) {
				console.warn(`⚠️ Données incomplètes ignorées :`, stop);
				continue;
			}

			const latitude = parseFloat(stop[4]);
			const longitude = parseFloat(stop[5]);

			if (isNaN(latitude) || isNaN(longitude)) {
				console.warn(`⚠️ Coordonnées invalides pour l'arrêt "${stop[2]}". Ignoré.`);
				continue;
			}

			arrets.push({
				stop_id: stop[0], // ✅ Ajout de stop_id
				nom: stop[2]?.replace(/"/g, "").trim() || "Inconnu",
				latitude,
				longitude,
				typeTransport: "Tram",
				lignesDesservies: [],
			});
		}

		// 🔹 Suppression et insertion optimisée
		await Arret.deleteMany();
		await Arret.insertMany(arrets);
		console.log(`✅ ${arrets.length} arrêts importés avec succès !`);

		process.exit();
	} catch (error) {
		console.error("❌ Erreur lors de l'importation des arrêts :", error);
		process.exit(1);
	}
};

importArrets();
