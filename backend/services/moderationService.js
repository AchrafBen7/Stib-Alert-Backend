const ModerationQueueItem = require("../models/ModerationQueueItem");
const Signalement = require("../models/Signalement");
const Cluster = require("../models/Cluster");
const DeviceLimit = require("../models/DeviceLimit");
const { incrementSpamFlag } = require("./communityRateLimiterService");
const { recomputeClusterFromReports } = require("./clusterService");

async function enqueueFlag({
	signalement,
	flagReason,
	flaggedBy = "system",
	spamScore = 0,
	spamReasons = [],
	priority = null,
	clusterIndex = null,
}) {
	if (!signalement) return null;

	const existing = await ModerationQueueItem.findOne({
		signalementId: signalement._id,
		status: "pending",
	});

	if (existing) {
		existing.spamScore = Math.max(existing.spamScore || 0, spamScore || 0);
		existing.spamReasons = Array.from(new Set([...(existing.spamReasons || []), ...spamReasons]));
		existing.priority = Math.max(existing.priority || 0, priority ?? deriveDefaultPriority(spamScore, flagReason));
		existing.priorityTier = ModerationQueueItem.tierFromPriority(existing.priority);
		await existing.save();
		return existing;
	}

	const effectivePriority = priority ?? deriveDefaultPriority(spamScore, flagReason);

	const item = await ModerationQueueItem.create({
		signalementId: signalement._id,
		clusterIndex: clusterIndex || signalement.clusterIndex || null,
		flagReason,
		flaggedBy,
		flaggedAt: new Date(),
		spamScore,
		spamReasons,
		signalementSnapshot: {
			ligne: signalement.ligne,
			arretId: signalement.arretId,
			typeProbleme: signalement.typeProbleme,
			description: signalement.description,
			reporterDeviceHash: signalement.reporterDeviceHash,
			reporterIpHash: signalement.reporterIpHash,
			latitude: signalement.latitude,
			longitude: signalement.longitude,
			authorType: signalement.authorType,
			createdAt: signalement.dateSignalement || signalement.createdAt,
		},
		priority: effectivePriority,
		priorityTier: ModerationQueueItem.tierFromPriority(effectivePriority),
		status: "pending",
	});

	if (!signalement.flagged) {
		signalement.flagged = true;
		signalement.flagReason = flagReason;
		signalement.flaggedAt = new Date();
		await signalement.save();
	}

	return item;
}

function deriveDefaultPriority(spamScore, flagReason) {
	if (flagReason === "offensive") return 95;
	if (flagReason === "misinformation") return 85;
	if (spamScore >= 85) return 80;
	if (spamScore >= 70) return 60;
	if (flagReason === "duplicate") return 50;
	if (flagReason === "auto_aged") return 25;
	return 50;
}

async function listQueue({
	status = "pending",
	priorityTier = null,
	limit = 50,
	skip = 0,
} = {}) {
	const query = { status };
	if (priorityTier) query.priorityTier = priorityTier;

	const total = await ModerationQueueItem.countDocuments(query);
	const items = await ModerationQueueItem.find(query)
		.sort({ priority: -1, flaggedAt: 1 })
		.skip(Math.max(0, skip))
		.limit(Math.min(Math.max(limit, 1), 200))
		.lean();

	return { items, total };
}

async function getQueueSummary() {
	const [pending, high, normal, low] = await Promise.all([
		ModerationQueueItem.countDocuments({ status: "pending" }),
		ModerationQueueItem.countDocuments({ status: "pending", priorityTier: "high" }),
		ModerationQueueItem.countDocuments({ status: "pending", priorityTier: "normal" }),
		ModerationQueueItem.countDocuments({ status: "pending", priorityTier: "low" }),
	]);

	const oldestPending = await ModerationQueueItem.findOne({ status: "pending" })
		.sort({ flaggedAt: 1 })
		.select("flaggedAt priorityTier")
		.lean();

	return {
		pending,
		breakdown: { high, normal, low },
		oldestFlaggedAt: oldestPending?.flaggedAt || null,
		oldestPriorityTier: oldestPending?.priorityTier || null,
	};
}

async function applyAction({ flagId, action, adminUserId = null, reason = null }) {
	const item = await ModerationQueueItem.findById(flagId);
	if (!item) {
		const e = new Error("Flag not found");
		e.status = 404;
		throw e;
	}
	if (item.status !== "pending") {
		const e = new Error("Flag already actioned");
		e.status = 409;
		throw e;
	}

	const signalement = await Signalement.findById(item.signalementId);

	const now = new Date();
	item.actionedAt = now;
	item.actionedBy = adminUserId;
	item.actionReason = reason;

	let clusterStatus = null;
	let banApplied = false;

	switch (action) {
	case "approve": {
		item.status = "approved";
		if (signalement) {
			signalement.flagged = false;
			signalement.flagReason = null;
			signalement.flaggedAt = null;
			signalement.moderationStatus = "approved";
			await signalement.save();
		}
		break;
	}
	case "reject": {
		item.status = "rejected";
		if (signalement) {
			signalement.flagged = false;
			signalement.flagReason = null;
			signalement.flaggedAt = null;
			signalement.moderationStatus = "approved";
			await signalement.save();
		}
		break;
	}
	case "remove": {
		item.status = "removed";
		if (signalement) {
			signalement.status = "spam";
			signalement.moderationStatus = "rejected";
			signalement.moderationReason = reason || "Spam removed by moderator";
			signalement.flagged = true;
			signalement.flagReason = "spam";
			signalement.flaggedAt = now;
			await signalement.save();

			if (signalement.reporterDeviceHash) {
				const device = await DeviceLimit.findById(signalement.reporterDeviceHash);
				if (device) {
					device.moderationRejectionCount = (device.moderationRejectionCount || 0) + 1;
					await device.save();
				}
				await incrementSpamFlag(signalement.reporterDeviceHash, { reason: "mod_remove" });
				banApplied = true;
			}

			if (signalement.clusterIndex) {
				const cluster = await Cluster.findOne({ clusterIndex: signalement.clusterIndex });
				if (cluster) {
					cluster.signalementIds = cluster.signalementIds.filter(
						(id) => String(id) !== String(signalement._id)
					);
					await recomputeClusterFromReports(cluster);
					clusterStatus = cluster.status;
				}
			}
		}
		break;
	}
	case "escalate": {
		item.status = "escalated";
		item.priority = 95;
		item.priorityTier = "high";
		break;
	}
	default: {
		const e = new Error(`Unknown action: ${action}`);
		e.status = 400;
		throw e;
	}
	}

	await item.save();

	return {
		item,
		clusterStatus,
		banApplied,
	};
}

async function flagBySignalementId(signalementId, { reason = "spam", flaggedBy = "user", note = null }) {
	const signalement = await Signalement.findById(signalementId);
	if (!signalement) {
		const e = new Error("Signalement not found");
		e.status = 404;
		throw e;
	}

	return enqueueFlag({
		signalement,
		flagReason: reason,
		flaggedBy,
		spamReasons: note ? [`user_note:${note.substring(0, 100)}`] : [],
		priority: reason === "offensive" ? 95 : 65,
	});
}

module.exports = {
	enqueueFlag,
	listQueue,
	getQueueSummary,
	applyAction,
	flagBySignalementId,
	deriveDefaultPriority,
};
