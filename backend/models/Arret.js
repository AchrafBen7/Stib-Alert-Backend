const mongoose = require("mongoose");

const arretSchema = new mongoose.Schema({
	stop_id: { type: String, required: true, unique: true }, // ID unique de l'arrêt
	merged_stop_id: { type: String, unique: true, sparse: true },
	nom: { type: String, required: true },
	latitude: { type: Number, required: true },
	longitude: { type: Number, required: true },
	physicalStopIds: [{ type: String }],
	typeTransport: [{ type: String, enum: ["Tram", "Bus", "Métro", "Train"] }],
	lignesDesservies: [{ type: String }],
	etat: { type: String, enum: ["Vert", "Orange", "Rouge"], default: "Vert" },
	signalementsRecents: [{ type: mongoose.Schema.Types.ObjectId, ref: "Signalement" }],
	order: { type: Map, of: Number },
	sourceDataset: { type: String },
});

module.exports = mongoose.model("Arret", arretSchema);
