const mongoose = require("mongoose");
const Ligne = require("./models/Ligne");
const Arret = require("./models/Arret");
require("dotenv").config();

async function run() {
	await mongoose.connect(process.env.MONGO_URI);

	const lignes = await Ligne.find();
	for (const ligne of lignes) {
		// Récupère tous les arrêts desservant cette ligne
		const stops = await Arret.find({ lignesDesservies: ligne.lineid });

		// Tri simple sur la partie numérique de stop_id
		stops.sort((a, b) => {
			const na = parseInt(a.stop_id.match(/\d+/)[0]);
			const nb = parseInt(b.stop_id.match(/\d+/)[0]);
			return na - nb;
		});

		// Met à jour l'ordre pour chaque arrêt
		for (let i = 0; i < stops.length; i++) {
			await Arret.findByIdAndUpdate(stops[i]._id, {
				$set: { [`order.${ligne.lineid}`]: i + 1 },
			});
		}
	}

	console.log("✅ Orders populated for all lines");
	process.exit(0);
}

run().catch((err) => {
	console.error(err);
	process.exit(1);
});
