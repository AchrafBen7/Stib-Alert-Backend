const mongoose = require("mongoose");

const stopFragilitySnapshotSchema = new mongoose.Schema(
	{
		stopId: { type: mongoose.Schema.Types.ObjectId, ref: "Arret", required: false },
		stopNameLower: { type: String, required: true, index: true },
		line: { type: String, required: false, index: true },
		hourBucket: { type: Number, required: true, min: 0, max: 23, index: true },
		score: { type: Number, required: true, default: 0 },
		signalCount: { type: Number, required: true, default: 0 },
		confirmations: { type: Number, required: true, default: 0 },
		stillBlocked: { type: Number, required: true, default: 0 },
		resolved: { type: Number, required: true, default: 0 },
		windowDays: { type: Number, required: true, default: 21 },
		lastSignalementAt: { type: Date, required: false },
	},
	{ timestamps: true }
);

stopFragilitySnapshotSchema.index({ stopNameLower: 1, hourBucket: 1, line: 1 }, { unique: true });

module.exports = mongoose.model("StopFragilitySnapshot", stopFragilitySnapshotSchema);
