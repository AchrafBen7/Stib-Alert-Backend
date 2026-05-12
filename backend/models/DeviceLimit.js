const mongoose = require("mongoose");

const deviceLimitSchema = new mongoose.Schema(
	{
		_id: {
			type: String,
			required: true,
		},

		reportCount24h: { type: Number, default: 0, min: 0 },
		reportCountHour: { type: Number, default: 0, min: 0 },
		lastReportTimestamps: {
			type: [Date],
			default: [],
			validate: {
				validator: (v) => v.length <= 20,
				message: "lastReportTimestamps cannot exceed 20 entries",
			},
		},
		lastStopsReported: {
			type: [String],
			default: [],
			validate: {
				validator: (v) => v.length <= 10,
				message: "lastStopsReported cannot exceed 10 entries",
			},
		},
		lastLineIds: {
			type: [String],
			default: [],
			validate: {
				validator: (v) => v.length <= 10,
				message: "lastLineIds cannot exceed 10 entries",
			},
		},

		isBanned: { type: Boolean, default: false, index: true },
		banReason: { type: String, default: null },
		bannedAt: { type: Date, default: null },
		banExpiresAt: { type: Date, default: null, index: true },

		spamFlagCount: { type: Number, default: 0, min: 0 },
		successfulReportCount: { type: Number, default: 0, min: 0 },
		moderationRejectionCount: { type: Number, default: 0, min: 0 },

		firstSeenAt: { type: Date, default: Date.now },
	},
	{
		timestamps: true,
		_id: false,
	}
);

deviceLimitSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90, name: "device_limit_ttl" });

deviceLimitSchema.methods.isCurrentlyBanned = function () {
	if (!this.isBanned) return false;
	if (this.banExpiresAt && this.banExpiresAt < new Date()) {
		this.isBanned = false;
		this.banReason = null;
		this.banExpiresAt = null;
		return false;
	}
	return true;
};

deviceLimitSchema.methods.pushTimestamp = function (timestamp) {
	this.lastReportTimestamps = [
		...this.lastReportTimestamps.slice(-9),
		timestamp,
	];
};

deviceLimitSchema.methods.pushStop = function (stopId) {
	if (!stopId) return;
	this.lastStopsReported = [
		...this.lastStopsReported.filter((s) => s !== stopId).slice(-4),
		stopId,
	];
};

deviceLimitSchema.methods.pushLine = function (lineId) {
	if (!lineId) return;
	this.lastLineIds = [
		...this.lastLineIds.filter((l) => l !== lineId).slice(-4),
		lineId,
	];
};

module.exports = mongoose.model("DeviceLimit", deviceLimitSchema);
