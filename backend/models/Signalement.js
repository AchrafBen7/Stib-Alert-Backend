const mongoose = require("mongoose");

const signalementSchema = new mongoose.Schema(
	{
		utilisateurId: { type: mongoose.Schema.Types.ObjectId, ref: "Utilisateur", required: false },
		arretId: { type: mongoose.Schema.Types.ObjectId, ref: "Arret", required: false },
		source: { type: String, enum: ["community", "stib_officiel"], default: "community" },
		authorType: {
			type: String,
			enum: ["authenticated", "anonymous", "official"],
			default: "anonymous",
		},
		moderationStatus: {
			type: String,
			enum: ["approved", "pending", "rejected"],
			default: "approved",
		},
		moderatedAt: { type: Date, default: null },
		moderatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Utilisateur", default: null },
		moderationReason: { type: String, trim: true, maxlength: 280, default: null },
		reporterIpHash: { type: String, default: null },
		reporterDeviceHash: { type: String, default: null },
		externalId: { type: String, default: null },
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
		abuseReports: [{ ip: { type: String, required: true }, createdAt: { type: Date, default: Date.now } }],

		// 📍 Coordonnées GPS du signalement
		latitude: { type: Number, required: false },
		longitude: { type: Number, required: false },

		// 🔹 Niveau de confiance du signalement
		confiance: {
			type: String,
			enum: ["haute", "moyenne", "basse"],
			default: "basse",
		},
		status: {
			type: String,
			enum: ["active", "resolved"],
			default: "active",
		},
		communityEvents: [{
			userId: { type: mongoose.Schema.Types.ObjectId, ref: "Utilisateur", required: false },
			action: {
				type: String,
				enum: ["confirm", "still_blocked", "resolved"],
				required: true,
			},
			createdAt: {
				type: Date,
				default: Date.now,
			},
		}],
	},
	{ timestamps: true }
);

const ttlDays = Number.parseInt(process.env.SIGNALEMENT_TTL_DAYS || "30", 10);

signalementSchema.index({ dateSignalement: -1 });
signalementSchema.index({ externalId: 1 }, { sparse: true });
signalementSchema.index({ arretId: 1, dateSignalement: -1 });
signalementSchema.index({ ligne: 1, dateSignalement: -1 });
signalementSchema.index({ ligne: 1, arretId: 1, dateSignalement: -1 });
signalementSchema.index({ status: 1, dateSignalement: -1 });
signalementSchema.index({ moderationStatus: 1, dateSignalement: -1 });
signalementSchema.index({ authorType: 1, moderationStatus: 1, dateSignalement: -1 });
signalementSchema.index({ reporterIpHash: 1, dateSignalement: -1 });
signalementSchema.index({ reporterDeviceHash: 1, dateSignalement: -1 });
signalementSchema.index(
	{ dateSignalement: 1 },
	{ expireAfterSeconds: Math.max(ttlDays, 1) * 24 * 60 * 60, name: "signalement_ttl" }
);

module.exports = mongoose.model("Signalement", signalementSchema);
