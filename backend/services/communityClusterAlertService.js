const Utilisateur = require("../models/Utilisateur");
const Arret = require("../models/Arret");
const AssistantNotificationLog = require("../models/AssistantNotificationLog");
const { sendNotificationWithDeepLink } = require("./oneSignalService");
const { isInQuietHours } = require("./pushPreferences");
const logger = require("./logger");

// Community polish — cooldown 4h → 1h. Trop conservateur avant : un user
// qui prend les transports matin + soir ratait potentiellement le push du
// retour parce qu'il avait reçu celui du matin sur la même ligne. 1h reste
// suffisant pour ne pas spammer (même cluster 2 fois dans la même heure
// = même incident, push 1 fois).
const COMMUNITY_CLUSTER_COOLDOWN_MS = 60 * 60 * 1000;
const NOTIFICATION_TYPE = "community_cluster_alert";
// A3 — re-sollicitation "toujours le cas ?".
const STILL_HAPPENING_TYPE = "community_still_happening";
const STILL_HAPPENING_COOLDOWN_MS = 30 * 60 * 1000;

function normalizeId(value) {
	return value && value._id ? value._id : value;
}

function readableProblem(typeProbleme) {
	const labels = {
		Accident: "accident signalé",
		Retard: "retard signalé",
		Panne: "panne signalée",
		Incivilité: "incident signalé",
		Propreté: "problème de propreté",
		Agression: "alerte sécurité",
		Autre: "perturbation signalée",
	};
	return labels[typeProbleme] || "perturbation signalée";
}

function buildCommunityClusterPushContent(cluster, arret) {
	const stopName = arret?.nom || "ton arrêt favori";
	const line = cluster.ligne ? `ligne ${cluster.ligne}` : "une ligne";
	const count = cluster.reportCount || 3;
	const problem = readableProblem(cluster.typeProbleme);

	return {
		title: `Alerte à ${stopName}`,
		message: `${count} signalements sur la ${line}: ${problem}. Ouvre l'app pour vérifier ou recalculer.`,
	};
}

async function sendAlertsForPublishedCommunityCluster(cluster) {
	const arretId = normalizeId(cluster?.arretId);

	if (!cluster || cluster.isOfficial) {
		return { sent: 0, skipped: 0, reason: "not_community_cluster" };
	}

	if (!arretId || !cluster.ligne || !cluster.clusterIndex) {
		return { sent: 0, skipped: 0, reason: "missing_cluster_context" };
	}

	const contextKey = `community_cluster:${cluster.clusterIndex}`;
	const arret = await Arret.findById(arretId).select("nom lignesDesservies").lean();
	const { title, message } = buildCommunityClusterPushContent(cluster, arret);

	let users = [];
	try {
		users = await Utilisateur.find({
			notifications: true,
			communityClusterPushEnabled: { $ne: false },
			oneSignalPlayerId: { $exists: true, $ne: null },
			favoris: arretId,
		})
			.select("_id oneSignalPlayerId quietHoursEnabled quietHoursStartHour quietHoursEndHour")
			.lean();
	} catch (err) {
		logger.warn("[community-cluster-alert] user query failed", {
			clusterIndex: cluster.clusterIndex,
			arretId: String(arretId),
			error: err.message,
		});
		return { sent: 0, skipped: 0, reason: "user_query_failed" };
	}

	let sent = 0;
	let skipped = 0;

	for (const user of users) {
		if (isInQuietHours(user)) {
			skipped++;
			continue;
		}

		const recent = await AssistantNotificationLog.findOne({
			userId: user._id,
			type: NOTIFICATION_TYPE,
			contextKey,
			sentAt: { $gte: new Date(Date.now() - COMMUNITY_CLUSTER_COOLDOWN_MS) },
		}).lean();

		if (recent) {
			skipped++;
			continue;
		}

		const result = await sendNotificationWithDeepLink({
			userId: String(user._id),
			title,
			message,
			type: NOTIFICATION_TYPE,
			id: String(cluster.clusterIndex),
			deepLink: `stibalert://clusters/${cluster.clusterIndex}`,
		});

		if (result?.success === false) {
			skipped++;
			continue;
		}

		await AssistantNotificationLog.create({
			userId: user._id,
			type: NOTIFICATION_TYPE,
			contextKey,
			priority: "high",
			title,
			message,
			sentAt: new Date(),
		});

		sent++;
	}

	return { sent, skipped, targetUsers: users.length };
}

// A3 — Demande aux témoins proches si la situation persiste. Envoyé pour un
// cluster actif qui n'a plus bougé depuis ~20 min : "Is de situatie nog
// steeds hetzelfde?". Le tap ouvre le détail (boutons Toujours bloqué / Résolu).
async function sendStillHappeningPrompts(cluster) {
	const arretId = normalizeId(cluster?.arretId);
	if (!cluster || cluster.isOfficial) return { sent: 0, reason: "not_community_cluster" };
	if (!arretId || !cluster.ligne || !cluster.clusterIndex) return { sent: 0, reason: "missing_context" };

	const arret = await Arret.findById(arretId).select("nom").lean();
	const stopName = arret?.nom || "ton arrêt";
	const title = `Toujours bloqué à ${stopName} ?`;
	const message = `La ${cluster.ligne ? `ligne ${cluster.ligne}` : "ligne"} est-elle encore perturbée ? Confirme ou indique que c'est rentré dans l'ordre.`;
	const contextKey = `still_happening:${cluster.clusterIndex}`;

	let users = [];
	try {
		users = await Utilisateur.find({
			notifications: true,
			communityClusterPushEnabled: { $ne: false },
			oneSignalPlayerId: { $exists: true, $ne: null },
			favoris: arretId,
		})
			.select("_id quietHoursEnabled quietHoursStartHour quietHoursEndHour")
			.lean();
	} catch (err) {
		logger.warn("[still-happening] user query failed", { error: err.message });
		return { sent: 0, reason: "user_query_failed" };
	}

	let sent = 0;
	for (const user of users) {
		if (isInQuietHours(user)) continue;
		const recent = await AssistantNotificationLog.findOne({
			userId: user._id,
			type: STILL_HAPPENING_TYPE,
			contextKey,
			sentAt: { $gte: new Date(Date.now() - STILL_HAPPENING_COOLDOWN_MS) },
		}).lean();
		if (recent) continue;

		const result = await sendNotificationWithDeepLink({
			userId: String(user._id),
			title,
			message,
			type: STILL_HAPPENING_TYPE,
			id: String(cluster.clusterIndex),
			deepLink: `stibalert://clusters/${cluster.clusterIndex}`,
		});
		if (result?.success === false) continue;

		await AssistantNotificationLog.create({
			userId: user._id,
			type: STILL_HAPPENING_TYPE,
			contextKey,
			priority: "normal",
			title,
			message,
			sentAt: new Date(),
		});
		sent++;
	}

	return { sent, targetUsers: users.length };
}

module.exports = {
	COMMUNITY_CLUSTER_COOLDOWN_MS,
	sendAlertsForPublishedCommunityCluster,
	sendStillHappeningPrompts,
};
