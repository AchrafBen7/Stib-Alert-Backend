const mongoose = require("mongoose");

const utilisateurSchema = new mongoose.Schema(
	{
		nom: { type: String, required: true },
		email: { type: String, required: true, unique: true },
		motDePasse: { type: String, required: true },
		photoProfil: { type: String },
		tokenPush: { type: String },
		favoris: [{ type: mongoose.Schema.Types.ObjectId, ref: "Arret" }],
		langue: { type: String, enum: ["FR", "NL", "EN"], default: "FR" },
		notifications: { type: Boolean, default: true },
		role: { type: String, enum: ["Utilisateur", "Admin"], default: "Utilisateur" },
		votes: [{ type: mongoose.Schema.Types.ObjectId, ref: "Signalement" }], // ✅ Liste des signalements votés
	},
	{ timestamps: true }
);

module.exports = mongoose.model("Utilisateur", utilisateurSchema);
