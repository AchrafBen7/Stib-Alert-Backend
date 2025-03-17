const mongoose = require("mongoose");

const arretSchema = new mongoose.Schema({
	stop_id: { type: String, required: true, unique: true }, // ID unique de l'arrêt
	nom: { type: String, required: true },
	latitude: { type: Number, required: true },
	longitude: { type: Number, required: true },
	typeTransport: [{ type: String, enum: ["Tram", "Bus", "Métro"] }],
	lignesDesservies: [{ type: String }],
	etat: { type: String, enum: ["Vert", "Orange", "Rouge"], default: "Vert" },
	signalementsRecents: [{ type: mongoose.Schema.Types.ObjectId, ref: "Signalement" }],
});

module.exports = mongoose.model("Arret", arretSchema);
