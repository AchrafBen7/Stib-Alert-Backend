const mongoose = require("mongoose");

const signalementSchema = new mongoose.Schema(
	{
		utilisateurId: { type: mongoose.Schema.Types.ObjectId, ref: "Utilisateur", required: false },
		arretId: { type: mongoose.Schema.Types.ObjectId, ref: "Arret", required: true }, // ✅ Doit être requis !
		ligne: { type: String, required: true },
		typeProbleme: {
			type: String,
			enum: ["Retard", "Accident", "Panne", "Propreté", "Agression", "Incivilité", "Autre"],
			required: true,
		},
		description: { type: String, required: true },
		photo: { type: String },
		dateSignalement: {
			type: Date,
			default: () => {
				let now = new Date();
				now.setSeconds(0, 0); // ✅ Supprime les secondes et millisecondes
				return now;
			},
		},
		validationIA: { type: Boolean, default: false },
		resumeIA: { type: String },

		// 🔹 Votes (approbation et rejet)
		votesPositifs: { type: Number, default: 0 }, // 👍 Approuvé par les utilisateurs
		votesNegatifs: { type: Number, default: 0 }, // 👎 Jugé faux par les utilisateurs
		signalements: { type: Number, default: 0 }, // 🚨 Nombre de signalements pour faux signalement

		// 📍 Coordonnées GPS du signalement
		latitude: { type: Number, required: false },
		longitude: { type: Number, required: false },

		// 🔹 Niveau de confiance du signalement
		confiance: {
			type: String,
			enum: ["haute", "moyenne", "basse"],
			default: "basse",
		},
	},
	{ timestamps: true }
);

module.exports = mongoose.model("Signalement", signalementSchema);
