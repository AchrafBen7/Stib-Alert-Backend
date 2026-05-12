const mongoose = require("mongoose");

const contributionSchema = new mongoose.Schema(
	{
		utilisateurId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: "Utilisateur",
			required: true,
			index: true,
		},
		signalementId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: "Signalement",
			required: true,
		},
		clusterIndex: { type: Number, default: null, index: true },

		// Snapshot at contribution time (denormalized for fast user stats).
		ligne: { type: String, default: null },
		typeProbleme: { type: String, default: null },
		arretNom: { type: String, default: null },

		role: {
			type: String,
			enum: ["first_reporter", "confirmer", "resolver", "still_blocked_voter"],
			default: "confirmer",
		},

		// Did this contribution actually help publish the cluster?
		helpedPublishCluster: { type: Boolean, default: false },
		clusterPublishedAt: { type: Date, default: null },

		// Filled async by the "thanks" job when N>=3 other people confirmed.
		thanksSent: { type: Boolean, default: false, index: true },
		thanksSentAt: { type: Date, default: null },
		peopleHelped: { type: Number, default: 0 },
	},
	{ timestamps: true }
);

contributionSchema.index({ utilisateurId: 1, createdAt: -1 });
contributionSchema.index({ clusterIndex: 1, utilisateurId: 1 }, { unique: true, sparse: true });
contributionSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90, name: "contribution_ttl" });

contributionSchema.statics.recordReport = async function ({
	utilisateurId,
	signalement,
	cluster,
	role = "confirmer",
}) {
	if (!utilisateurId || !signalement) return null;
	try {
		return await this.findOneAndUpdate(
			{ utilisateurId, signalementId: signalement._id },
			{
				$setOnInsert: {
					utilisateurId,
					signalementId: signalement._id,
					clusterIndex: cluster?.clusterIndex || signalement.clusterIndex || null,
					ligne: signalement.ligne || null,
					typeProbleme: signalement.typeProbleme || null,
					role,
					createdAt: new Date(),
				},
				$set: {
					helpedPublishCluster: cluster?.status === "active",
					clusterPublishedAt: cluster?.status === "active" ? (cluster.lastReportedAt || new Date()) : null,
				},
			},
			{ upsert: true, new: true }
		);
	} catch (e) {
		// Unique-index conflict on (clusterIndex, utilisateurId) → silently skip.
		return null;
	}
};

contributionSchema.statics.summaryForUser = async function (utilisateurId) {
	if (!utilisateurId) {
		return {
			totalContributions: 0,
			publishedClusters: 0,
			peopleHelpedTotal: 0,
			firstReporterCount: 0,
		};
	}
	const all = await this.find({ utilisateurId })
		.select("role helpedPublishCluster peopleHelped clusterIndex")
		.lean();

	const publishedClusters = new Set(
		all.filter((c) => c.helpedPublishCluster && c.clusterIndex != null).map((c) => c.clusterIndex)
	).size;

	const peopleHelpedTotal = all.reduce((acc, c) => acc + (c.peopleHelped || 0), 0);
	const firstReporterCount = all.filter((c) => c.role === "first_reporter").length;

	return {
		totalContributions: all.length,
		publishedClusters,
		peopleHelpedTotal,
		firstReporterCount,
	};
};

module.exports = mongoose.model("Contribution", contributionSchema);
