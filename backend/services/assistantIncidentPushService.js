const Utilisateur = require("../models/Utilisateur");
const Arret = require("../models/Arret");
const AssistantNotificationLog = require("../models/AssistantNotificationLog");
const { sendNotificationWithDeepLink } = require("./oneSignalService");
const { buildCommunityMeta } = require("./signalementCommunityService");
const { isInQuietHours } = require("./pushPreferences");
const { evaluatePush, logDeferred } = require("./notificationPolicyService");

const EVENT_POLICY = {
	new_signalement: { cooldownMinutes: 15, priority: "elevated" },
	still_blocked: { cooldownMinutes: 20, priority: "elevated" },
	resolved: { cooldownMinutes: 30, priority: "normal" },
};

async function shouldSkipEventPush({ userId, type, contextKey, title, message }) {
	const cooldownMinutes = EVENT_POLICY[type]?.cooldownMinutes || 20;
	const threshold = new Date(Date.now() - cooldownMinutes * 60 * 1000);
	const recent = await AssistantNotificationLog.findOne({
		userId,
		type,
		contextKey,
		sentAt: { $gte: threshold },
	})
		.sort({ sentAt: -1 })
		.lean();

	return Boolean(recent && recent.title === title && recent.message === message);
}

async function logEventPush({ userId, type, contextKey, incidentKey = null, title, message, decision = null, stage = null }) {
	await AssistantNotificationLog.create({
		userId,
		type,
		contextKey,
		incidentKey,
		priority: EVENT_POLICY[type]?.priority || "normal",
		title,
		message,
		decision,
		stage,
		sentAt: new Date(),
	});
}

function toRadians(value) {
	return (value * Math.PI) / 180;
}

function distanceMeters(a, b) {
	if (!a || !b) return Number.POSITIVE_INFINITY;
	const earthRadius = 6371000;
	const dLat = toRadians(b.lat - a.lat);
	const dLng = toRadians(b.lng - a.lng);
	const lat1 = toRadians(a.lat);
	const lat2 = toRadians(b.lat);
	const sinLat = Math.sin(dLat / 2);
	const sinLng = Math.sin(dLng / 2);
	const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
	return 2 * earthRadius * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

async function resolveTargetStopIds(signalement) {
	const stopIds = new Set();
	const rawStopId = signalement.arretId?._id || signalement.arretId;
	if (rawStopId) {
		stopIds.add(String(rawStopId));
	}

	const line = String(signalement.ligne || "").trim();
	if (!line) {
		return [...stopIds];
	}

	const incidentLocation = signalement.latitude != null && signalement.longitude != null
		? { lat: Number(signalement.latitude), lng: Number(signalement.longitude) }
		: signalement.arretId?.latitude != null && signalement.arretId?.longitude != null
			? { lat: Number(signalement.arretId.latitude), lng: Number(signalement.arretId.longitude) }
			: null;

	const lineStops = await Arret.find({ lignesDesservies: line })
		.select("_id latitude longitude")
		.lean();

	for (const stop of lineStops) {
		if (!incidentLocation) {
			stopIds.add(String(stop._id));
			continue;
		}

		const stopLocation = stop.latitude != null && stop.longitude != null
			? { lat: Number(stop.latitude), lng: Number(stop.longitude) }
			: null;
		const distance = distanceMeters(incidentLocation, stopLocation);
		if (distance <= 2200) {
			stopIds.add(String(stop._id));
		}
	}

	return [...stopIds];
}

function buildEventPayload(user, signalement, eventType) {
	const stopName = signalement.arretId?.nom || signalement.arretId?.name || "un arrêt favori";
	const line = signalement.ligne;
	const community = buildCommunityMeta(signalement);
	const favoriteLines = (user.favoriteLines || []).map((item) => String(item || "").toUpperCase());
	const departureTime = user.routine?.departureTime;
	const isFavoriteLine = line && favoriteLines.includes(String(line).toUpperCase());

	if (isFavoriteLine && eventType !== "resolved") {
		return {
			title: `Perturbation sur ta ligne ${line}`,
			message: departureTime
				? `Départ habituel ${departureTime}. ${stopName} est touché et Stibi surveille déjà une alternative.`
				: `${stopName} est touché sur ta ligne favorite ${line}. Stibi surveille déjà la suite.`,
		};
	}

	if (isFavoriteLine && eventType === "resolved") {
		return {
			title: `Ligne ${line} plus stable`,
			message: departureTime
				? `Ta ligne favorite ${line} semble rétablie avant ton départ habituel ${departureTime}.`
				: `Ta ligne favorite ${line} semble de nouveau exploitable.`,
		};
	}

	if (eventType === "resolved") {
		return {
			title: `${stopName} semble rétabli`,
			message: line
				? `Le problème sur la ligne ${line} à ${stopName} semble résolu.`
				: `Le problème signalé à ${stopName} semble résolu.`,
		};
	}

	if (eventType === "still_blocked") {
		return {
			title: `${stopName} reste perturbé`,
			message: line
				? `${community.confirmations || 0} confirmations indiquent que la ligne ${line} reste perturbée à ${stopName}.`
				: `${community.confirmations || 0} confirmations indiquent que le problème reste actif à ${stopName}.`,
		};
	}

	return {
		title: `Nouvelle alerte à ${stopName}`,
		message: line
			? `Un nouveau signalement touche la ligne ${line} à ${stopName}.`
			: `Un nouveau signalement vient d’être publié à ${stopName}.`,
	};
}

async function sendFavoriteIncidentPushes(signalement, eventType = "new_signalement") {
	const stopIds = await resolveTargetStopIds(signalement);
	if (!stopIds.length) return { sent: 0, evaluated: 0 };
	const primaryStopId = String(signalement.arretId?._id || signalement.arretId || stopIds[0]);
	const line = String(signalement.ligne || "").trim();

	const users = await Utilisateur.find({
		notifications: true,
		// "Alertes communauté" toggle — exclude users who turned it off.
		communityClusterPushEnabled: { $ne: false },
		oneSignalPlayerId: { $exists: true, $ne: null },
		$or: [
			{ favoris: { $in: stopIds } },
			{ "routine.homeStopId": { $in: stopIds } },
			{ "routine.workStopId": { $in: stopIds } },
			...(line ? [{ favoriteLines: line.toUpperCase() }] : []),
		],
	})
		.select("_id favoriteLines routine quietHoursEnabled quietHoursStartHour quietHoursEndHour notificationFrequency notificationRules")
		.lean();

	let sent = 0;
	// BUG #1 — Mêmes types que perturbationAlertService : Accident et
	// Agression bypassent les quiet hours (info sécurité urgente).
	const CRITICAL_INCIDENT_TYPES = new Set(["Accident", "Agression"]);
	const isCritical = CRITICAL_INCIDENT_TYPES.has(signalement?.typeProbleme);

	for (const user of users) {
		// Respect the user's silent window — sauf si incident critique.
		if (!isCritical && isInQuietHours(user)) continue;

		const payload = buildEventPayload(user, signalement, eventType);
		const contextKey = `${primaryStopId}:${line || "line-unknown"}:${eventType}`;
		const skip = await shouldSkipEventPush({
			userId: user._id,
			type: eventType,
			contextKey,
			title: payload.title,
			message: payload.message,
		});
		if (skip) {
			continue;
		}

		// #1/#2/#3/#4 — débit, dé-dup inter-types (incidentKey+étape), plafond,
		// règle par ligne/arrêt. `stage` = type d'événement (new/still/resolved).
		const decision = await evaluatePush({
			userId: user._id,
			user,
			ligne: line,
			stopId: primaryStopId,
			stage: eventType,
			isCritical,
		});
		if (!decision.allow) {
			if (decision.defer) {
				await logDeferred({ userId: user._id, type: `corridor_${eventType}`, incidentKey: decision.incidentKey, title: payload.title, message: payload.message, stage: eventType });
			}
			continue;
		}

		await sendNotificationWithDeepLink({
			userId: String(user._id),
			title: payload.title,
			message: payload.message,
			type: `corridor_${eventType}`,
			id: String(signalement._id),
			deepLink: `stibalert://signalement/${signalement._id}`,
		});

		await logEventPush({
			userId: user._id,
			type: eventType,
			contextKey,
			incidentKey: decision.incidentKey,
			title: payload.title,
			message: payload.message,
			stage: eventType,
		});
		sent += 1;
	}

	return { sent, evaluated: users.length };
}

module.exports = {
	sendFavoriteIncidentPushes,
};
