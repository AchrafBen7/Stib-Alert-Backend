const Signalement = require("../models/Signalement");
const Cluster = require("../models/Cluster");
const { calculateAggregateTrust } = require("./trustScorerService");

let emitClusterEvent = null;
try {
	emitClusterEvent = require("../config/websocket").emitClusterEvent;
} catch (e) {
	emitClusterEvent = () => {};
}

const CLUSTER = {
	MIN_REPORTS_TO_PUBLISH: 3,
	MIN_TRUST_TO_PUBLISH: 50,
	REPORT_EXPIRY_MS: 2 * 60 * 60 * 1000,
	CLUSTER_LIFETIME_MS: 4 * 60 * 60 * 1000,
	RESOLVED_ARCHIVE_DELAY_MS: 30 * 60 * 1000,
	STILL_BLOCKED_EXTEND_MS: 2 * 60 * 60 * 1000,
	RESOLVE_THRESHOLD: 3,
	STILL_BLOCKED_THRESHOLD: 3,
};

function safeDate(value) {
	if (!value) return null;
	const d = value instanceof Date ? value : new Date(value);
	return Number.isFinite(d.getTime()) ? d : null;
}

function deriveConfidence(reportCount, aggregateTrust) {
	if (reportCount >= 5 && aggregateTrust >= 70) return "high";
	if (reportCount >= 4 && aggregateTrust >= 60) return "high";
	if (reportCount >= 3 && aggregateTrust >= 50) return "medium";
	return "low";
}

function uniqueContributors(reports) {
	const seen = new Set();
	const unique = [];
	for (const report of reports) {
		const key = report.utilisateurId
			? `u:${String(report.utilisateurId)}`
			: report.reporterDeviceHash
				? `d:${report.reporterDeviceHash}`
				: report.reporterIpHash
					? `i:${report.reporterIpHash}`
					: null;
		if (!key || seen.has(key)) continue;
		seen.add(key);
		unique.push(report);
	}
	return unique;
}

async function findOrCreateCluster({ ligne, arretId, typeProbleme }) {
	let cluster = await Cluster.findOne({
		ligne,
		arretId,
		typeProbleme,
		status: { $in: ["active", "unpublished"] },
		expiresAt: { $gt: new Date() },
	});

	if (cluster) return { cluster, isNew: false };

	const clusterIndex = await Cluster.nextIndex();
	cluster = new Cluster({
		clusterIndex,
		ligne,
		arretId,
		typeProbleme,
		signalementIds: [],
		reportCount: 0,
		aggregateTrust: 50,
		confidence: "low",
		firstReportedAt: new Date(),
		lastReportedAt: new Date(),
		expiresAt: new Date(Date.now() + CLUSTER.REPORT_EXPIRY_MS),
		status: "unpublished",
	});
	return { cluster, isNew: true };
}

function safeEmit(eventType, cluster) {
	try {
		if (typeof emitClusterEvent === "function") {
			emitClusterEvent(eventType, cluster);
		}
	} catch (err) {
		console.warn("[clusterService] emit failed:", err.message);
	}
}

async function recomputeClusterFromReports(cluster) {
	const reports = await Signalement.find({
		_id: { $in: cluster.signalementIds },
		status: { $nin: ["spam", "archived"] },
		moderationStatus: { $ne: "rejected" },
	})
		.select("trust utilisateurId reporterDeviceHash reporterIpHash dateSignalement latitude longitude")
		.lean();

	const uniqueReports = uniqueContributors(reports);
	const reportCount = uniqueReports.length;

	if (reportCount === 0) {
		cluster.reportCount = 0;
		cluster.aggregateTrust = 50;
		cluster.confidence = "low";
		cluster.status = "archived";
		cluster.archivedAt = new Date();
		await cluster.save();
		return cluster;
	}

	const aggregateTrust = await calculateAggregateTrust(uniqueReports.map((r) => r._id));
	const lastReport = reports.reduce((latest, r) => {
		const d = safeDate(r.dateSignalement);
		if (!d) return latest;
		return latest && latest > d ? latest : d;
	}, null) || new Date();

	const lat = uniqueReports.find((r) => Number.isFinite(r.latitude))?.latitude || cluster.latitude;
	const lng = uniqueReports.find((r) => Number.isFinite(r.longitude))?.longitude || cluster.longitude;

	cluster.reportCount = reportCount;
	cluster.aggregateTrust = aggregateTrust;
	cluster.confidence = deriveConfidence(reportCount, aggregateTrust);
	cluster.lastReportedAt = lastReport;
	cluster.latitude = lat;
	cluster.longitude = lng;

	const shouldPublish =
		reportCount >= CLUSTER.MIN_REPORTS_TO_PUBLISH &&
		aggregateTrust >= CLUSTER.MIN_TRUST_TO_PUBLISH;

	if (cluster.resolved) {
		cluster.status = "resolved";
	} else if (shouldPublish) {
		cluster.status = "active";
	} else {
		cluster.status = "unpublished";
	}

	const maxLifetime = new Date(cluster.firstReportedAt.getTime() + CLUSTER.CLUSTER_LIFETIME_MS);
	const fromLastReport = new Date(lastReport.getTime() + CLUSTER.REPORT_EXPIRY_MS);
	cluster.expiresAt = fromLastReport > maxLifetime ? maxLifetime : fromLastReport;

	const wasActive = cluster.isModified("status") ? cluster.get("status", null, { getters: false }) : null;
	await cluster.save();

	if (cluster.status === "active" && wasActive !== "active") {
		safeEmit("published", cluster);
	} else if (cluster.status === "archived") {
		safeEmit("archived", cluster);
	} else if (cluster.status === "active") {
		safeEmit("updated", cluster);
	}

	return cluster;
}

async function assignSignalementToCluster(signalement) {
	const ligne = signalement.ligne;
	const arretId = signalement.arretId;
	const typeProbleme = signalement.typeProbleme;

	if (!ligne || !arretId || !typeProbleme) {
		return { cluster: null, published: false, reason: "missing_fields" };
	}

	const { cluster, isNew } = await findOrCreateCluster({ ligne, arretId, typeProbleme });

	const alreadyIncluded = cluster.signalementIds.some((id) => String(id) === String(signalement._id));
	if (!alreadyIncluded) {
		cluster.signalementIds.push(signalement._id);
	}

	signalement.clusterIndex = cluster.clusterIndex;
	if (signalement.status === "active") {
		signalement.status = "grouped";
	}
	await signalement.save();

	await recomputeClusterFromReports(cluster);

	return {
		cluster,
		isNew,
		published: cluster.status === "active",
		clusterIndex: cluster.clusterIndex,
	};
}

async function confirmStillBlocked({ clusterIndex, userId, actorHash }) {
	const cluster = await Cluster.findOne({ clusterIndex });
	if (!cluster || cluster.status === "archived") {
		const e = new Error("Cluster not found");
		e.status = 404;
		throw e;
	}

	if (cluster.status === "resolved") {
		return {
			cluster,
			message: "Cette alerte a déjà été résolue.",
			alreadyResolved: true,
		};
	}

	cluster.stillBlockedConfirmationCount = (cluster.stillBlockedConfirmationCount || 0) + 1;
	const newExpiry = new Date(Date.now() + CLUSTER.STILL_BLOCKED_EXTEND_MS);
	const maxLifetime = new Date(cluster.firstReportedAt.getTime() + CLUSTER.CLUSTER_LIFETIME_MS);
	cluster.expiresAt = newExpiry > maxLifetime ? maxLifetime : newExpiry;
	cluster.lastReportedAt = new Date();
	await cluster.save();

	safeEmit("still_blocked", cluster);

	return {
		cluster,
		message: "Confirmation enregistrée. L'alerte reste active.",
		confirmationCount: cluster.stillBlockedConfirmationCount,
	};
}

async function confirmResolved({ clusterIndex, userId, actorHash }) {
	const cluster = await Cluster.findOne({ clusterIndex });
	if (!cluster || cluster.status === "archived") {
		const e = new Error("Cluster not found");
		e.status = 404;
		throw e;
	}

	if (cluster.resolved) {
		return {
			cluster,
			alreadyResolved: true,
			message: "Cette alerte est déjà résolue.",
		};
	}

	cluster.resolveConfirmationCount = (cluster.resolveConfirmationCount || 0) + 1;

	if (cluster.resolveConfirmationCount >= CLUSTER.RESOLVE_THRESHOLD) {
		cluster.resolved = true;
		cluster.resolvedAt = new Date();
		cluster.status = "resolved";
		cluster.archivedAt = new Date(Date.now() + CLUSTER.RESOLVED_ARCHIVE_DELAY_MS);

		await Signalement.updateMany(
			{ _id: { $in: cluster.signalementIds }, status: { $nin: ["archived", "spam"] } },
			{ $set: { status: "resolved", resolvedAt: new Date() } }
		);
	}

	await cluster.save();

	if (cluster.resolved) {
		safeEmit("resolved", cluster);
	} else {
		safeEmit("resolve_vote", cluster);
	}

	return {
		cluster,
		confirmationCount: cluster.resolveConfirmationCount,
		resolved: cluster.resolved,
		message: cluster.resolved
			? "Alerte marquée comme résolue. Merci !"
			: `Confirmation enregistrée (${cluster.resolveConfirmationCount}/${CLUSTER.RESOLVE_THRESHOLD}).`,
	};
}

async function getActiveClusters({ bbox = null, lineId = null, limit = 100 } = {}) {
	const now = new Date();
	const query = {
		status: "active",
		expiresAt: { $gt: now },
	};

	if (lineId) query.ligne = String(lineId);

	if (bbox && bbox.minLat != null && bbox.maxLat != null && bbox.minLng != null && bbox.maxLng != null) {
		query.latitude = { $gte: bbox.minLat, $lte: bbox.maxLat };
		query.longitude = { $gte: bbox.minLng, $lte: bbox.maxLng };
	}

	return Cluster.find(query)
		.sort({ lastReportedAt: -1 })
		.limit(Math.min(Math.max(limit, 1), 500))
		.lean();
}

async function getClusterDetail(clusterIndex, { maxReports = 5 } = {}) {
	const cluster = await Cluster.findOne({ clusterIndex }).lean();
	if (!cluster) return null;

	const reports = await Signalement.find({
		_id: { $in: cluster.signalementIds },
		moderationStatus: { $ne: "rejected" },
	})
		.select("description trust dateSignalement utilisateurId reporterDeviceHash authorType")
		.sort({ dateSignalement: -1 })
		.limit(maxReports)
		.lean();

	return {
		...cluster,
		signalements: reports.map((r) => ({
			description: r.description,
			trust: r.trust,
			timestamp: r.dateSignalement,
			source: r.utilisateurId ? "user" : "anonymous",
		})),
	};
}

async function runClusteringSweep({ batchSize = 200 } = {}) {
	const now = new Date();
	const reports = await Signalement.find({
		status: { $in: ["active", "grouped"] },
		moderationStatus: "approved",
		expiresAt: { $gt: now },
		clusterIndex: null,
	})
		.sort({ dateSignalement: -1 })
		.limit(batchSize)
		.populate("arretId", "_id name");

	let assigned = 0;
	for (const report of reports) {
		try {
			await assignSignalementToCluster(report);
			assigned++;
		} catch (err) {
			console.error("[clusterService] assign error:", err.message);
		}
	}

	const activeClusters = await Cluster.find({
		status: { $in: ["active", "unpublished"] },
		expiresAt: { $lte: now },
	});

	let archivedCount = 0;
	for (const cluster of activeClusters) {
		cluster.status = "archived";
		cluster.archivedAt = new Date();
		await cluster.save();
		await Signalement.updateMany(
			{ _id: { $in: cluster.signalementIds }, status: { $nin: ["resolved", "spam", "archived"] } },
			{ $set: { status: "archived" } }
		);
		archivedCount++;
	}

	const expiredResolved = await Cluster.find({
		status: "resolved",
		archivedAt: { $lte: now },
	});

	for (const cluster of expiredResolved) {
		cluster.status = "archived";
		await cluster.save();
		archivedCount++;
	}

	return { assigned, archivedCount, totalProcessed: reports.length };
}

module.exports = {
	CLUSTER,
	assignSignalementToCluster,
	confirmStillBlocked,
	confirmResolved,
	getActiveClusters,
	getClusterDetail,
	runClusteringSweep,
	recomputeClusterFromReports,
	deriveConfidence,
	uniqueContributors,
};
