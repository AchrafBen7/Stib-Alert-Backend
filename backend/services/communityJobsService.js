const { runClusteringSweep } = require("./clusterService");
const Signalement = require("../models/Signalement");
const Cluster = require("../models/Cluster");
const DeviceLimit = require("../models/DeviceLimit");

const CLUSTERING_INTERVAL_MS = parseInt(process.env.COMMUNITY_CLUSTERING_INTERVAL_MS, 10) || 30 * 1000;
const EXPIRATION_INTERVAL_MS = parseInt(process.env.COMMUNITY_EXPIRATION_INTERVAL_MS, 10) || 60 * 1000;
const CLEANUP_INTERVAL_MS = parseInt(process.env.COMMUNITY_CLEANUP_INTERVAL_MS, 10) || 60 * 60 * 1000;

let clusteringTimer = null;
let expirationTimer = null;
let cleanupTimer = null;

async function clusteringTick() {
	try {
		const result = await runClusteringSweep();
		if (result.assigned > 0 || result.archivedCount > 0) {
			console.log(`[community-jobs] clustering: assigned=${result.assigned} archived=${result.archivedCount}`);
		}
	} catch (error) {
		console.error("[community-jobs] clusteringTick error:", error.message);
	}
}

async function expirationTick() {
	const now = new Date();

	try {
		const expiredReports = await Signalement.updateMany(
			{
				status: { $in: ["active", "grouped"] },
				expiresAt: { $lt: now },
				resolvedAt: null,
			},
			{
				$set: { status: "archived" },
			}
		);

		const expiredClusters = await Cluster.find({
			status: { $in: ["active", "unpublished"] },
			expiresAt: { $lt: now },
		});

		for (const cluster of expiredClusters) {
			cluster.status = "archived";
			cluster.archivedAt = now;
			await cluster.save();
		}

		const resolvedToArchive = await Cluster.updateMany(
			{
				status: "resolved",
				archivedAt: { $ne: null, $lt: now },
			},
			{
				$set: { status: "archived" },
			}
		);

		if (
			(expiredReports.modifiedCount && expiredReports.modifiedCount > 0) ||
			expiredClusters.length > 0 ||
			(resolvedToArchive.modifiedCount && resolvedToArchive.modifiedCount > 0)
		) {
			console.log(
				`[community-jobs] expiration: reports=${expiredReports.modifiedCount || 0} clusters=${expiredClusters.length} resolved->archived=${resolvedToArchive.modifiedCount || 0}`
			);
		}
	} catch (error) {
		console.error("[community-jobs] expirationTick error:", error.message);
	}
}

async function cleanupTick() {
	const now = new Date();

	try {
		const expiredBans = await DeviceLimit.updateMany(
			{
				isBanned: true,
				banExpiresAt: { $ne: null, $lt: now },
			},
			{
				$set: { isBanned: false, banReason: null, banExpiresAt: null },
			}
		);

		const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
		await DeviceLimit.updateMany(
			{ updatedAt: { $lt: yesterday }, reportCount24h: { $gt: 0 } },
			{ $set: { reportCount24h: 0, reportCountHour: 0 } }
		);

		if (expiredBans.modifiedCount > 0) {
			console.log(`[community-jobs] cleanup: unbanned=${expiredBans.modifiedCount}`);
		}
	} catch (error) {
		console.error("[community-jobs] cleanupTick error:", error.message);
	}
}

function startCommunityJobs() {
	if (process.env.COMMUNITY_JOBS_ENABLED === "false") {
		console.warn("⚠️ Community jobs disabled via COMMUNITY_JOBS_ENABLED=false");
		return null;
	}

	if (clusteringTimer || expirationTimer || cleanupTimer) {
		console.warn("[community-jobs] already running");
		return { clusteringTimer, expirationTimer, cleanupTimer };
	}

	clusteringTick().catch(() => {});
	clusteringTimer = setInterval(clusteringTick, CLUSTERING_INTERVAL_MS);
	clusteringTimer.unref?.();

	expirationTick().catch(() => {});
	expirationTimer = setInterval(expirationTick, EXPIRATION_INTERVAL_MS);
	expirationTimer.unref?.();

	cleanupTimer = setInterval(cleanupTick, CLEANUP_INTERVAL_MS);
	cleanupTimer.unref?.();

	console.log(
		`✅ Community jobs started (clustering=${CLUSTERING_INTERVAL_MS}ms, expiration=${EXPIRATION_INTERVAL_MS}ms, cleanup=${CLEANUP_INTERVAL_MS}ms)`
	);

	return { clusteringTimer, expirationTimer, cleanupTimer };
}

function stopCommunityJobs() {
	if (clusteringTimer) {
		clearInterval(clusteringTimer);
		clusteringTimer = null;
	}
	if (expirationTimer) {
		clearInterval(expirationTimer);
		expirationTimer = null;
	}
	if (cleanupTimer) {
		clearInterval(cleanupTimer);
		cleanupTimer = null;
	}
}

module.exports = {
	startCommunityJobs,
	stopCommunityJobs,
	clusteringTick,
	expirationTick,
	cleanupTick,
};
