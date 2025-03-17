const mongoose = require("mongoose");

const ligneSchema = new mongoose.Schema({
	lineid: { type: String, required: true, unique: true },
	nomComplet: { type: String, required: true },
	nomCompletRetour: { type: String },
	typeTransport: { type: String, enum: ["Tram", "Bus", "Métro"], required: true },
	couleur: { type: String, required: true },
	destination: {
		fr: { type: String, required: true },
		nl: { type: String, required: true },
	},
	direction: { type: String, enum: ["City", "Suburb"], required: true },
	points: [
		{
			id: { type: mongoose.Schema.Types.ObjectId, ref: "Arret", required: true },
			order: { type: Number, required: true },
		},
	],
});

module.exports = mongoose.model("Ligne", ligneSchema);
