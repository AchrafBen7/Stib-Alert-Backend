const mongoose = require("mongoose");

const signalementSchema = new mongoose.Schema({
	utilisateurId: { type: mongoose.Schema.Types.ObjectId, ref: "Utilisateur", required: false },
	arretId: { type: mongoose.Schema.Types.ObjectId, ref: "Arret", required: true }, // ✅ Doit être requis !
	ligne: { type: String, required: true },
	typeProbleme: { type: String, enum: ["Retard", "Accident", "Panne"], required: true },
	description: { type: String, required: true },
	photo: { type: String },
	dateSignalement: { type: Date, default: Date.now },
	validationIA: { type: Boolean, default: false },
	resumeIA: { type: String },
	votes: { type: Number, default: 0 },
});

module.exports = mongoose.model("Signalement", signalementSchema);
