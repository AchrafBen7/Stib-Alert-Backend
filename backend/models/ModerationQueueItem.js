const mongoose = require("mongoose");

const moderationQueueSchema = new mongoose.Schema(
	{
		signalementId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: "Signalement",
			required: true,
			index: true,
		},
		clusterIndex: { type: Number, default: null, index: true },

		flagReason: {
			type: String,
			enum: ["spam", "offensive", "duplicate", "misinformation", "auto_aged", "url_detected", "rapid_fire", "geographic_outlier", "sensitive_review"],
			required: true,
		},
		flaggedBy: {
			type: mongoose.Schema.Types.Mixed,
			default: "system",
		},
		flaggedAt: { type: Date, default: Date.now, index: true },

		spamScore: { type: Number, default: 0, min: 0, max: 100 },
		spamReasons: [{ type: String }],

		signalementSnapshot: {
			ligne: String,
			arretId: mongoose.Schema.Types.ObjectId,
			typeProbleme: String,
			description: String,
			reporterDeviceHash: String,
			reporterIpHash: String,
			latitude: Number,
			longitude: Number,
			authorType: String,
			createdAt: Date,
		},

		status: {
			type: String,
			enum: ["pending", "approved", "rejected", "removed", "escalated"],
			default: "pending",
			index: true,
		},
		actionedAt: { type: Date, default: null },
		actionedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Utilisateur", default: null },
		actionReason: { type: String, default: null, maxlength: 280 },

		priority: { type: Number, default: 50, min: 1, max: 100 },
		priorityTier: {
			type: String,
			enum: ["high", "normal", "low"],
			default: "normal",
		},
	},
	{ timestamps: true }
);

moderationQueueSchema.index({ status: 1, priority: -1, flaggedAt: 1 });
moderationQueueSchema.index({ status: 1, priorityTier: 1, flaggedAt: 1 });
moderationQueueSchema.index({ flaggedAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 60, name: "moderation_ttl" });

moderationQueueSchema.statics.tierFromPriority = function (priority) {
	if (priority >= 80) return "high";
	if (priority >= 40) return "normal";
	return "low";
};

module.exports = mongoose.model("ModerationQueueItem", moderationQueueSchema);
