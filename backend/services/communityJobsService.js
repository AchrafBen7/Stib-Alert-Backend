const { runClusteringSweep } = require("./clusterService");
const Signalement = require("../models/Signalement");
const Cluster = require("../models/Cluster");
const DeviceLimit = require("../models/DeviceLimit");

let sendStillHappeningPrompts = null;
let sendDeferredDigests = null;
try {
	const svc = require("./communityClusterAlertService");
	sendStillHappeningPrompts = svc.sendStillHappeningPrompts;
	sendDeferredDigests = svc.sendDeferredDigests;
} catch (e) {
	sendStillHappeningPrompts = null;
	sendDeferredDigests = null;
}

const CLUSTERING_INTERVAL_MS = parseInt(process.env.COMMUNITY_CLUSTERING_INTERVAL_MS, 10) || 30 * 1000;
const EXPIRATION_INTERVAL_MS = parseInt(process.env.COMMUNITY_EXPIRATION_INTERVAL_MS, 10) || 60 * 1000;
const CLEANUP_INTERVAL_MS = parseInt(process.env.COMMUNITY_CLEANUP_INTERVAL_MS, 10) || 60 * 60 * 1000;
// A3 — re-sollicitation "toujours le cas ?".
const STILL_HAPPENING_INTERVAL_MS = parseInt(process.env.COMMUNITY_STILL_HAPPENING_INTERVAL_MS, 10) || 5 * 60 * 1000;
// Digest des notifications reportées (plafond de fréquence / mode digest).
const DIGEST_INTERVAL_MS = parseInt(process.env.COMMUNITY_DIGEST_INTERVAL_MS, 10) || 30 * 60 * 1000;
const STILL_HAPPENING_QUIET_MIN = 20;   // pas de nouvelle activité depuis 20 min
const STILL_HAPPENING_MIN_AGE_MIN = 25;  // cluster vieux d'au moins 25 min
const STILL_HAPPENING_REPROMPT_MIN = 30; // ne pas re-demander avant 30 min

let clusteringTimer = null;
let expirationTimer = null;
let cleanupTimer = null;
let stillHappeningTimer = null;
let digestTimer = null;

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

// A3 — Demande aux témoins proches si l'incident persiste, pour les clusters
// actifs qui n'ont plus bougé. Garde le terrain à jour ("capteurs humains").
async function stillHappeningTick() {
	if (!sendStillHappeningPrompts) return;
	const now = Date.now();
	try {
		const candidates = await Cluster.find({
			status: "active",
			isOfficial: { $ne: true },
			resolved: { $ne: true },
			firstReportedAt: { $lt: new Date(now - STILL_HAPPENING_MIN_AGE_MIN * 60 * 1000) },
			lastReportedAt: { $lt: new Date(now - STILL_HAPPENING_QUIET_MIN * 60 * 1000) },
			$or: [
				{ lastStillHappeningPromptAt: null },
				{ lastStillHappeningPromptAt: { $lt: new Date(now - STILL_HAPPENING_REPROMPT_MIN * 60 * 1000) } },
			],
		})
			.sort({ lastReportedAt: 1 })
			.limit(20);

		let prompted = 0;
		for (const cluster of candidates) {
			try {
				const result = await sendStillHappeningPrompts(cluster);
				cluster.lastStillHappeningPromptAt = new Date();
				await cluster.save();
				if (result?.sent > 0) prompted += result.sent;
			} catch (err) {
				console.warn("[community-jobs] still-happening prompt failed:", err.message);
			}
		}
		if (prompted > 0) {
			console.log(`[community-jobs] still-happening: prompts sent=${prompted} clusters=${candidates.length}`);
		}
	} catch (error) {
		console.error("[community-jobs] stillHappeningTick error:", error.message);
	}
}

// Digest : envoie les résumés des notifications reportées.
async function digestTick() {
	if (!sendDeferredDigests) return;
	try {
		const result = await sendDeferredDigests();
		if (result?.sent > 0) {
			console.log(`[community-jobs] digest: summaries sent=${result.sent}`);
		}
	} catch (error) {
		console.error("[community-jobs] digestTick error:", error.message);
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

	stillHappeningTimer = setInterval(() => { stillHappeningTick().catch(() => {}); }, STILL_HAPPENING_INTERVAL_MS);
	stillHappeningTimer.unref?.();

	digestTimer = setInterval(() => { digestTick().catch(() => {}); }, DIGEST_INTERVAL_MS);
	digestTimer.unref?.();

	console.log(
		`✅ Community jobs started (clustering=${CLUSTERING_INTERVAL_MS}ms, expiration=${EXPIRATION_INTERVAL_MS}ms, cleanup=${CLEANUP_INTERVAL_MS}ms, stillHappening=${STILL_HAPPENING_INTERVAL_MS}ms, digest=${DIGEST_INTERVAL_MS}ms)`
	);

	return { clusteringTimer, expirationTimer, cleanupTimer, stillHappeningTimer, digestTimer };
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
	if (stillHappeningTimer) {
		clearInterval(stillHappeningTimer);
		stillHappeningTimer = null;
	}
	if (digestTimer) {
		clearInterval(digestTimer);
		digestTimer = null;
	}
}

module.exports = {
	startCommunityJobs,
	stopCommunityJobs,
	clusteringTick,
	expirationTick,
	cleanupTick,
	stillHappeningTick,
	digestTick,
};
