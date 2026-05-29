const mongoose = require("mongoose");

const clusterSchema = new mongoose.Schema(
	{
		clusterIndex: {
			type: Number,
			unique: true,
			required: true,
			index: true,
		},

		ligne: { type: String, required: true, index: true },
		arretId: { type: mongoose.Schema.Types.ObjectId, ref: "Arret", required: true, index: true },
		typeProbleme: {
			type: String,
			enum: ["Retard", "Accident", "Panne", "Propreté", "Agression", "Incivilité", "Travaux", "Déviation", "Interruption", "Arrêt non desservi", "Perturbation", "Information STIB", "Autre"],
			required: true,
		},

		signalementIds: [{
			type: mongoose.Schema.Types.ObjectId,
			ref: "Signalement",
		}],
		reportCount: { type: Number, default: 0, min: 0 },

		aggregateTrust: { type: Number, default: 50, min: 0, max: 100 },
		confidence: {
			type: String,
			enum: ["low", "medium", "high"],
			default: "low",
		},
		// A1 — Score de confiance UNIFIÉ 0–1 + statut bucketé (seuil ≥0.80
		// = confirmé, ≥0.50 = probable, sinon à vérifier). Source de vérité
		// unique qui agrège corroboration (K) + réputation/proximité (U) +
		// récence (R) + officiel (O).
		confidenceScore: { type: Number, default: 0.3, min: 0, max: 1 },
		confidenceStatus: {
			type: String,
			enum: ["confirmed", "likely", "unverified"],
			default: "unverified",
		},
		// A6 — Résumé IA structuré (wat / waarom / hoelang / wat nu).
		summary: { type: String, default: null },
		summaryUpdatedAt: { type: Date, default: null },
		summaryReportCount: { type: Number, default: 0 },
		// A3 — anti-spam de la re-sollicitation "toujours le cas ?".
		lastStillHappeningPromptAt: { type: Date, default: null },

		firstReportedAt: { type: Date, default: Date.now },
		lastReportedAt: { type: Date, default: Date.now, index: true },
		expiresAt: { type: Date, required: true, index: true },

		resolved: { type: Boolean, default: false },
		resolveConfirmationCount: { type: Number, default: 0, min: 0 },
		stillBlockedConfirmationCount: { type: Number, default: 0, min: 0 },
		resolvedAt: { type: Date, default: null },

		status: {
			type: String,
			enum: ["active", "resolved", "archived", "unpublished"],
			default: "active",
			index: true,
		},
		archivedAt: { type: Date, default: null },

		isOfficial: { type: Boolean, default: false },
		officialSignalementId: { type: mongoose.Schema.Types.ObjectId, ref: "Signalement", default: null },

		latitude: { type: Number, default: null },
		longitude: { type: Number, default: null },
	},
	{ timestamps: true }
);

clusterSchema.index({ ligne: 1, arretId: 1, typeProbleme: 1, status: 1 });
clusterSchema.index({ status: 1, expiresAt: 1 });
clusterSchema.index({ status: 1, lastReportedAt: -1 });
clusterSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30, name: "cluster_ttl" });

clusterSchema.methods.computeConfidence = function () {
	if (this.aggregateTrust >= 70 && this.reportCount >= 4) return "high";
	if (this.aggregateTrust >= 55 || this.reportCount >= 3) return "medium";
	return "low";
};

clusterSchema.statics.nextIndex = async function () {
	const latest = await this.findOne({}, { clusterIndex: 1 }).sort({ clusterIndex: -1 }).lean();
	return (latest?.clusterIndex || 0) + 1;
};

module.exports = mongoose.model("Cluster", clusterSchema);
