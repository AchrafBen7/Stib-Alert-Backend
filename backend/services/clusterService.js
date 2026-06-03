const Signalement = require("../models/Signalement");
const Cluster = require("../models/Cluster");
const ClusterVote = require("../models/ClusterVote");
const { calculateAggregateTrust } = require("./trustScorerService");
const logger = require("./logger");

// Enregistre UN vote par acteur (user ou device) et par type sur un cluster.
// Renvoie true si le vote est nouveau, false s'il est en double (déjà voté).
// S'appuie sur l'index unique de ClusterVote : la duplicate-key (E11000) est
// le signal "déjà voté", géré sans throw. Fail-open prudent : si l'écriture
// échoue pour une autre raison, on autorise le vote (mieux vaut un compteur
// imparfait qu'un blocage total du système communautaire).
async function recordVoteOnce({ clusterIndex, voteType, userId, actorHash }) {
	const actorKey = userId ? `u:${userId}` : actorHash ? `d:${actorHash}` : null;
	if (!actorKey) return true; // pas d'identité → on ne peut pas dédupliquer
	try {
		await ClusterVote.create({ clusterIndex, voteType, actorKey });
		return true;
	} catch (err) {
		if (err && err.code === 11000) return false; // déjà voté
		logger.warn("[clusterService] vote dedup write failed", { error: err.message });
		return true;
	}
}

let emitClusterEvent = null;
try {
	emitClusterEvent = require("../config/websocket").emitClusterEvent;
} catch (e) {
	emitClusterEvent = () => {};
}

let sendAlertsForPublishedCommunityCluster = null;
try {
	sendAlertsForPublishedCommunityCluster =
		require("./communityClusterAlertService").sendAlertsForPublishedCommunityCluster;
} catch (e) {
	sendAlertsForPublishedCommunityCluster = null;
}

// A6 — Générateur de résumé IA (optionnel, fail-open).
let genererResumeCluster = null;
try {
	genererResumeCluster = require("../config/openai").genererResumeCluster;
} catch (e) {
	genererResumeCluster = null;
}

const SUMMARY_MIN_INTERVAL_MS = 90 * 1000;

// A6 — Régénère (en arrière-plan, non bloquant) le résumé "wat/waarom/
// hoelang/wat nu" quand le cluster actif a évolué. Throttlé pour ne pas
// marteler OpenAI sur une rafale de confirmations.
function maybeRegenerateClusterSummary(cluster) {
	if (!genererResumeCluster || cluster.status !== "active") return;
	const countChanged = cluster.summaryReportCount !== cluster.reportCount;
	const stale = !cluster.summaryUpdatedAt
		|| (Date.now() - new Date(cluster.summaryUpdatedAt).getTime()) > SUMMARY_MIN_INTERVAL_MS;
	if (!countChanged && cluster.summary) return;
	if (!stale) return;

	// Fire-and-forget : ne ralentit JAMAIS le chemin de création/vote.
	(async () => {
		try {
			const reports = await Signalement.find({ _id: { $in: cluster.signalementIds } })
				.select("description")
				.limit(25)
				.lean();
			const arret = await require("../models/Arret").findById(cluster.arretId).select("nom").lean().catch(() => null);
			const summary = await genererResumeCluster({
				ligne: cluster.ligne,
				arret: arret?.nom || "un arrêt",
				typeProbleme: cluster.typeProbleme,
				descriptions: reports.map((r) => r.description),
				reportCount: cluster.reportCount,
			});
			if (summary) {
				await Cluster.updateOne(
					{ _id: cluster._id },
					{ $set: { summary, summaryUpdatedAt: new Date(), summaryReportCount: cluster.reportCount } }
				);
				safeEmit("updated", { ...cluster.toObject?.() || cluster, summary });
			}
		} catch (err) {
			logger.warn("[clusterService] summary generation failed", { error: err.message });
		}
	})();
}

const CLUSTER = {
	MIN_REPORTS_TO_PUBLISH: 3,
	MIN_TRUST_TO_PUBLISH: 50,
	REPORT_EXPIRY_MS: 2 * 60 * 60 * 1000,
	CLUSTER_LIFETIME_MS: 4 * 60 * 60 * 1000,
	RESOLVED_ARCHIVE_DELAY_MS: 30 * 60 * 1000,
	STILL_BLOCKED_EXTEND_MS: 2 * 60 * 60 * 1000,

	// Resolution is ASYMMETRIC vs publication.
	// 1 vote from a high-trust user is enough — they were on the spot
	// and saw it's resolved. The default user threshold is 2 (instead of
	// the previous 3) to avoid punishing the user who first sees recovery.
	RESOLVE_THRESHOLD_DEFAULT: 2,
	RESOLVE_THRESHOLD_TRUSTED: 1,
	RESOLVE_TRUST_THRESHOLD: 75,

	// Natural decay: a cluster with no still_blocked vote for X minutes
	// quietly degrades and eventually auto-resolves.
	NATURAL_DECAY_MS: 30 * 60 * 1000,

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

// A1 — Score de confiance UNIFIÉ 0–1. Agrège les facteurs de la formule
// documentée : K (corroboration), U (réputation+proximité, déjà dans le
// trust), R (récence), O (officiel). Seuils : ≥0.80 confirmé, ≥0.50 probable.
function deriveUnifiedConfidence({ reportCount, aggregateTrust, freshnessMinutes, isOfficial, stillBlocked = 0, resolved = 0 }) {
	if (isOfficial) {
		return { score: 0.97, status: "confirmed" };
	}
	const K = Math.min(1, reportCount / 4);              // corroboration
	const U = Math.min(1, Math.max(0, aggregateTrust / 100)); // réputation + proximité
	const ageMin = Number.isFinite(freshnessMinutes) ? Math.max(0, freshnessMinutes) : 120;
	const R = Math.max(0, 1 - ageMin / 240);             // récence (≈0 à 4h)
	const stillBoost = Math.min(0.15, stillBlocked * 0.05);
	const resolvedPenalty = Math.min(0.4, resolved * 0.12);

	let score = 0.34 * K + 0.30 * U + 0.24 * R + 0.12;   // 0.12 = plancher "posté"
	score += stillBoost - resolvedPenalty;
	score = Math.min(0.99, Math.max(0.05, score));

	const status = score >= 0.80 ? "confirmed" : score >= 0.50 ? "likely" : "unverified";
	return { score: Number(score.toFixed(2)), status };
}

// A2 — Durée de vie par gravité (Klein 1h / Gemiddeld 3h / Ernstig 6h).
// Une alerte vieillit selon le TYPE d'incident : un accident reste pertinent
// longtemps, une affluence se périme vite.
const LIFETIME_KLEIN_MS = 1 * 60 * 60 * 1000;
const LIFETIME_GEMIDDELD_MS = 3 * 60 * 60 * 1000;
const LIFETIME_ERNSTIG_MS = 6 * 60 * 60 * 1000;

function incidentLifetimeMs(typeProbleme) {
	const t = String(typeProbleme || "").toLowerCase();
	// Ernstig (6h) — sécurité / coupure réseau majeure.
	if (["accident", "agression", "interruption", "travaux"].some((k) => t.includes(k))) {
		return LIFETIME_ERNSTIG_MS;
	}
	// Gemiddeld (3h) — exploitation dégradée.
	if (["panne", "déviation", "deviation", "retard", "non desservi", "perturbation"].some((k) => t.includes(k))) {
		return LIFETIME_GEMIDDELD_MS;
	}
	// Klein (1h) — confort / info.
	return LIFETIME_KLEIN_MS;
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
		logger.warn("[clusterService] emit failed", { error: err.message });
	}
}

async function recomputeClusterFromReports(cluster) {
	const previousStatus = cluster.status;

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

	// A1 — Score de confiance unifié 0–1 + statut (confirmé/probable/à vérifier).
	const freshnessMinutes = Math.max(0, (Date.now() - lastReport.getTime()) / 60000);
	const unified = deriveUnifiedConfidence({
		reportCount,
		aggregateTrust,
		freshnessMinutes,
		isOfficial: cluster.isOfficial,
		stillBlocked: cluster.stillBlockedConfirmationCount || 0,
		resolved: cluster.resolveConfirmationCount || 0,
	});
	cluster.confidenceScore = unified.score;
	cluster.confidenceStatus = unified.status;

	// Community polish — voie rapide : si le trust agrégé est largement
	// au-dessus du seuil normal (65+ : généralement utilisateur vérifié
	// + device trusted), on accepte 2 reports au lieu de 3. Cela évite le
	// lag 30-40s observé sur les vraies perturbations rapportées par 2
	// utilisateurs réguliers (les cas où on voudrait publier le plus vite).
	const TRUSTED_FAST_TRACK_MIN_TRUST = 65;
	const TRUSTED_FAST_TRACK_MIN_REPORTS = 2;
	const shouldPublishFastTrack =
		reportCount >= TRUSTED_FAST_TRACK_MIN_REPORTS &&
		aggregateTrust >= TRUSTED_FAST_TRACK_MIN_TRUST;
	const shouldPublishNormal =
		reportCount >= CLUSTER.MIN_REPORTS_TO_PUBLISH &&
		aggregateTrust >= CLUSTER.MIN_TRUST_TO_PUBLISH;
	const shouldPublish = shouldPublishFastTrack || shouldPublishNormal;

	if (cluster.resolved) {
		cluster.status = "resolved";
	} else if (shouldPublish) {
		cluster.status = "active";
	} else {
		cluster.status = "unpublished";
	}

	// A2 — Expiration par gravité (Klein 1h / Gemiddeld 3h / Ernstig 6h).
	// Le cluster vit `lifetime` depuis le dernier report, plafonné à `lifetime`
	// depuis le 1er report.
	const lifetimeMs = incidentLifetimeMs(cluster.typeProbleme);
	const maxLifetime = new Date(cluster.firstReportedAt.getTime() + lifetimeMs);
	const fromLastReport = new Date(lastReport.getTime() + lifetimeMs);
	cluster.expiresAt = fromLastReport > maxLifetime ? maxLifetime : fromLastReport;

	await cluster.save();

	if (cluster.status === "active" && previousStatus !== "active") {
		safeEmit("published", cluster);
		if (typeof sendAlertsForPublishedCommunityCluster === "function") {
			try {
				await sendAlertsForPublishedCommunityCluster(cluster);
			} catch (err) {
				logger.warn("[clusterService] community cluster push failed", {
					clusterIndex: cluster.clusterIndex,
					error: err.message,
				});
			}
		}
	} else if (cluster.status === "archived") {
		safeEmit("archived", cluster);
	} else if (cluster.status === "active") {
		safeEmit("updated", cluster);
	}

	// A6 — Résumé IA (non bloquant) si le cluster actif a évolué.
	maybeRegenerateClusterSummary(cluster);

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

	const reportsNeeded = Math.max(0, CLUSTER.MIN_REPORTS_TO_PUBLISH - cluster.reportCount);
	const isFirstReporter = cluster.reportCount === 1 && isNew;

	return {
		cluster,
		isNew,
		isFirstReporter,
		reportsNeededToPublish: reportsNeeded,
		userVisible: true,
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

	// Anti-double-vote : un acteur ne compte qu'une fois.
	const isNewVote = await recordVoteOnce({
		clusterIndex,
		voteType: "still_blocked",
		userId,
		actorHash,
	});
	if (!isNewVote) {
		return {
			cluster,
			message: "Tu as déjà confirmé cette alerte.",
			alreadyVoted: true,
			confirmationCount: cluster.stillBlockedConfirmationCount || 0,
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

// B3 — Le seuil de résolution doit être PROPORTIONNEL aux confirmations
// "toujours bloqué" actives : sinon un seul vote d'un user trusted effaçait
// une alerte massivement confirmée. Règle : threshold = max(base trust,
// ceil(stillBlocked / 2)), avec un plancher absolu de 2 dès qu'au moins 3
// personnes ont confirmé que c'est toujours bloqué.
async function resolutionThresholdForVoter({ userId, stillBlocked = 0 } = {}) {
	let base = CLUSTER.RESOLVE_THRESHOLD_DEFAULT;
	if (userId) {
		try {
			const Utilisateur = require("../models/Utilisateur");
			const user = await Utilisateur.findById(userId).select("role createdAt").lean();
			if (user) {
				const accountAgeDays = (Date.now() - new Date(user.createdAt).getTime()) / 86_400_000;
				const isTrusted = user.role === "Admin" || accountAgeDays > 30;
				base = isTrusted ? CLUSTER.RESOLVE_THRESHOLD_TRUSTED : CLUSTER.RESOLVE_THRESHOLD_DEFAULT;
			}
		} catch (e) { /* base par défaut */ }
	}

	const active = Number.isFinite(stillBlocked) ? Math.max(0, stillBlocked) : 0;
	const proportional = Math.ceil(active / 2);
	let threshold = Math.max(base, proportional);
	if (active >= 3) threshold = Math.max(threshold, 2);
	return threshold;
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

	// Anti-double-vote : un acteur ne peut voter "résolu" qu'une fois.
	const isNewVote = await recordVoteOnce({
		clusterIndex,
		voteType: "resolved",
		userId,
		actorHash,
	});
	if (!isNewVote) {
		return {
			cluster,
			alreadyVoted: true,
			resolved: cluster.resolved,
			confirmationCount: cluster.resolveConfirmationCount || 0,
			message: "Tu as déjà voté pour cette alerte.",
		};
	}

	cluster.resolveConfirmationCount = (cluster.resolveConfirmationCount || 0) + 1;

	const threshold = await resolutionThresholdForVoter({
		userId,
		stillBlocked: cluster.stillBlockedConfirmationCount || 0,
	});

	if (cluster.resolveConfirmationCount >= threshold) {
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
		threshold,
		message: cluster.resolved
			? "Alerte marquée comme résolue. Merci !"
			: `Confirmation enregistrée (${cluster.resolveConfirmationCount}/${threshold}).`,
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
			logger.error("[clusterService] assign error", { error: err.message });
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

	// Natural decay: a cluster with no new still_blocked activity for
	// NATURAL_DECAY_MS minutes auto-resolves. Users don't need to vote
	// — silence = problem gone.
	const decayCutoff = new Date(now.getTime() - CLUSTER.NATURAL_DECAY_MS);
	const decayCandidates = await Cluster.find({
		status: "active",
		lastReportedAt: { $lt: decayCutoff },
		stillBlockedConfirmationCount: 0,
		resolved: false,
	});

	let decayedCount = 0;
	for (const cluster of decayCandidates) {
		cluster.resolved = true;
		cluster.resolvedAt = now;
		cluster.status = "resolved";
		cluster.archivedAt = new Date(now.getTime() + CLUSTER.RESOLVED_ARCHIVE_DELAY_MS);
		await cluster.save();
		safeEmit("auto_resolved", cluster);
		decayedCount++;
	}

	return { assigned, archivedCount, decayedCount, totalProcessed: reports.length };
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
