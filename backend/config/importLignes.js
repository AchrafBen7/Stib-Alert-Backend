const mongoose = require("mongoose");
const fs = require("fs");
require("dotenv").config();
const Ligne = require("../models/Ligne");

mongoose.connect(process.env.MONGO_URI, {
	autoIndex: false,
});

const importLignes = async () => {
	try {
		console.log("🚀 Importation des Lignes...");

		const rawRoutes = fs.readFileSync("./routes.txt", "utf-8").trim();
		const lignesRows = rawRoutes.split("\n").slice(1);

		for (const row of lignesRows) {
			const route = row.split(",");

			if (route.length < 8) {
				console.warn(`⚠️ Ligne ignorée (incomplète) :`, route);
				continue;
			}

			const lineid = route[1].trim(); // ✅ Numéro réel de la ligne
			const nomComplet = route[2]?.replace(/"/g, "").trim() || "Inconnu";
			const typeTransport = route[4] === "1" ? "Métro" : route[4] === "0" ? "Tram" : "Bus";
			const couleur = `#${route[6]}` || "#000000";

			const ligneExistante = await Ligne.findOne({ lineid });

			if (!ligneExistante) {
				await Ligne.create({
					lineid,
					nomComplet,
					typeTransport,
					couleur,
					destination: { fr: nomComplet, nl: "Te bepalen" },
					direction: "City",
					points: [],
				});
			}
		}

		console.log("✅ Lignes importées avec succès !");
		process.exit();
	} catch (error) {
		console.error("❌ Erreur lors de l'importation des lignes :", error);
		process.exit(1);
	}
};

importLignes();
