const Contribution = require("../models/Contribution");
const Cluster = require("../models/Cluster");
const Signalement = require("../models/Signalement");
const logger = require("./logger");

let oneSignal = null;
try {
	oneSignal = require("./oneSignalService");
} catch (e) {
	oneSignal = null;
}

const THANKS_MIN_HELPED = 3;
const THANKS_BATCH_INTERVAL_MS = parseInt(process.env.MERCIS_INTERVAL_MS, 10) || 5 * 60 * 1000;
let timer = null;

async function recordContribution({ utilisateurId, signalement, cluster, role = "confirmer" }) {
	if (!utilisateurId) return null;
	return Contribution.recordReport({ utilisateurId, signalement, cluster, role });
}

async function detectAndSendThanks() {
	const eligibleClusters = await Cluster.find({
		status: { $in: ["active", "resolved"] },
		reportCount: { $gte: THANKS_MIN_HELPED + 1 },
	})
		.select("clusterIndex signalementIds reportCount ligne typeProbleme lastReportedAt")
		.limit(50)
		.lean();

	let sent = 0;
	for (const cluster of eligibleClusters) {
		const contributions = await Contribution.find({
			clusterIndex: cluster.clusterIndex,
			thanksSent: false,
		}).populate("utilisateurId", "_id email nom oneSignalPlayerId notifications mercisPushEnabled quietHoursEnabled quietHoursStartHour quietHoursEndHour notificationFrequency");

		if (contributions.length === 0) continue;

		const peopleHelped = Math.max(0, cluster.reportCount - 1);
		if (peopleHelped < THANKS_MIN_HELPED) continue;

		for (const contribution of contributions) {
			const user = contribution.utilisateurId;
			if (!user) continue;

			contribution.thanksSent = true;
			contribution.thanksSentAt = new Date();
			contribution.peopleHelped = peopleHelped;
			await contribution.save();
			sent++;

			if (user.notifications === false) continue;
			if (user.mercisPushEnabled === false) continue;
			// B7 — Les "mercis" ne sont pas critiques : non envoyés en mode
			// "Critique seul" ou "Résumé".
			if (user.notificationFrequency === "critique" || user.notificationFrequency === "digest") continue;
			if (!user.oneSignalPlayerId) continue;

			try {
				if (oneSignal?.sendPushToPlayerIds) {
					await oneSignal.sendPushToPlayerIds({
						playerIds: [user.oneSignalPlayerId],
						title: "Merci",
						message: `Ton signalement sur la ligne ${cluster.ligne} a aidé ${peopleHelped} personne${peopleHelped > 1 ? "s" : ""} ce matin.`,
						data: {
							type: "thanks",
							clusterIndex: cluster.clusterIndex,
							peopleHelped,
						},
					});
				}
			} catch (pushErr) {
				logger.warn("[mercis] push failed", { error: pushErr.message });
			}
		}
	}

	return { sent };
}

function startMercisLoop() {
	if (process.env.MERCIS_ENABLED === "false") return null;
	if (timer) return timer;

	detectAndSendThanks().catch((e) => logger.warn("[mercis] initial run failed:", { error: e.message }));
	timer = setInterval(() => {
		detectAndSendThanks().catch((e) => logger.warn("[mercis] tick failed:", { error: e.message }));
	}, THANKS_BATCH_INTERVAL_MS);
	timer.unref?.();
	logger.info(`✅ Mercis loop started (interval=${THANKS_BATCH_INTERVAL_MS}ms)`);
	return timer;
}

function stopMercisLoop() {
	if (timer) {
		clearInterval(timer);
		timer = null;
	}
}

async function getUserContributionsSummary(utilisateurId) {
	return Contribution.summaryForUser(utilisateurId);
}

module.exports = {
	recordContribution,
	detectAndSendThanks,
	startMercisLoop,
	stopMercisLoop,
	getUserContributionsSummary,
};
