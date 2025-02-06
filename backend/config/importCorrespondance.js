const mongoose = require("mongoose");
const fs = require("fs");
require("dotenv").config();
const Arret = require("../models/Arret");

mongoose.connect(process.env.MONGO_URI, {
	autoIndex: false,
});

const importCorrespondance = async () => {
	try {
		console.log("🚀 Mise à jour de la correspondance Arrêts - Lignes...");

		const rawStopsByLine = fs.readFileSync("./stops-by-line-production.json", "utf-8");
		const stopsByLine = JSON.parse(rawStopsByLine);
		const updates = [];

		for (let ligne of stopsByLine) {
			for (let point of JSON.parse(ligne.points)) {
				updates.push({
					updateOne: {
						filter: { stop_id: point.id },
						update: { $addToSet: { lignesDesservies: ligne.lineid } },
					},
				});
			}
		}

		await Arret.bulkWrite(updates);
		console.log("✅ Correspondance Arrêts - Lignes mise à jour !");
		process.exit();
	} catch (error) {
		console.error("❌ Erreur lors de la mise à jour :", error);
		process.exit(1);
	}
};

importCorrespondance();
