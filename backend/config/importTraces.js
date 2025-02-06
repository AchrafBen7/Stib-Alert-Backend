const mongoose = require("mongoose");
const fs = require("fs");
require("dotenv").config();
const Trace = require("../models/Trace");
const Ligne = require("../models/Ligne");

mongoose.connect(process.env.MONGO_URI, {
	autoIndex: false,
});

const importTraces = async () => {
	try {
		console.log("🚀 Importation des Tracés des Lignes...");

		// Charger toutes les lignes
		const allLignes = await Ligne.find().select("_id lineid");
		const lignesMap = new Map(allLignes.map((l) => [l.lineid, l._id]));

		// Lire le fichier JSON
		const rawTraces = fs.readFileSync("./shapefiles-production.json", "utf-8");
		const tracesData = JSON.parse(rawTraces);

		let tracesAjoutes = 0;
		for (const trace of tracesData) {
			// 🔹 Normaliser le lineid
			const ligneNormalisee = trace.ligne.replace(/[a-zA-Z]$/, "").replace(/^0+/, "");
			const ligneId = lignesMap.get(ligneNormalisee);

			console.log(`🔍 Vérification : ligne '${trace.ligne}' → normalisée '${ligneNormalisee}' → trouvée '${ligneId}'`);

			if (!ligneId) {
				console.warn(`⚠️ Aucune correspondance trouvée pour '${trace.ligne}' (transformée en '${ligneNormalisee}').`);
				continue;
			}

			const existe = await Trace.findOne({ ligneId: ligneId });
			if (!existe) {
				await Trace.create({
					ligneId: ligneId,
					geoShape: trace.geo_shape.geometry.coordinates,
				});
				tracesAjoutes++;
			}
		}

		console.log(`✅ ${tracesAjoutes} tracés des lignes importés avec succès !`);
		process.exit();
	} catch (error) {
		console.error("❌ Erreur lors de l'importation des tracés :", error);
		process.exit(1);
	}
};

importTraces();
