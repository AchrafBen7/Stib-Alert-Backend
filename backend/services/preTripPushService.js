const Utilisateur = require("../models/Utilisateur");
const { computeDecision } = require("./decisionService");
const { brusselsHour } = require("./pushPreferences");
const logger = require("./logger");

let oneSignal = null;
try {
	oneSignal = require("./oneSignalService");
} catch (e) {
	oneSignal = null;
}

// How early before routine.departureTime we trigger the push.
const TRIGGER_LEAD_MINUTES = parseInt(process.env.PRE_TRIP_LEAD_MINUTES, 10) || 15;
// Allowed window around the trigger time (e.g. lead - 1min ≤ now ≤ lead + 1min).
const TRIGGER_WINDOW_MINUTES = parseInt(process.env.PRE_TRIP_WINDOW_MINUTES, 10) || 3;
// How often we evaluate users (default every 1 min).
const TICK_INTERVAL_MS = parseInt(process.env.PRE_TRIP_TICK_MS, 10) || 60 * 1000;

let timer = null;
let isRunning = false;

function parseDepartureTime(str) {
	if (!str || typeof str !== "string") return null;
	const m = str.match(/^(\d{1,2}):(\d{2})$/);
	if (!m) return null;
	const hour = Number(m[1]);
	const minute = Number(m[2]);
	if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
	return { hour, minute };
}

function minutesUntilDeparture(routine, now = new Date()) {
	const t = parseDepartureTime(routine?.departureTime);
	if (!t) return null;
	const target = new Date(now);
	target.setHours(t.hour, t.minute, 0, 0);
	if (target.getTime() < now.getTime() - 30 * 60 * 1000) {
		// Departure already past by more than 30 min -> consider tomorrow's window irrelevant for now.
		return Infinity;
	}
	return (target.getTime() - now.getTime()) / 60000;
}

function isWithinTriggerWindow(routine, now = new Date()) {
	const m = minutesUntilDeparture(routine, now);
	if (m == null) return false;
	const lower = TRIGGER_LEAD_MINUTES - TRIGGER_WINDOW_MINUTES;
	const upper = TRIGGER_LEAD_MINUTES + TRIGGER_WINDOW_MINUTES;
	return m >= lower && m <= upper;
}

function alreadyPushedToday(lastPushAt, now = new Date()) {
	if (!lastPushAt) return false;
	const last = new Date(lastPushAt);
	return last.toDateString() === now.toDateString();
}

function isWeekendWithoutOverride(now = new Date()) {
	const dayOfWeek = now.getDay(); // 0=Sunday, 6=Saturday
	return dayOfWeek === 0 || dayOfWeek === 6;
}

function isInQuietHours(user, now = new Date()) {
	if (user.quietHoursEnabled === false) return false;
	const start = Number.isInteger(user.quietHoursStartHour) ? user.quietHoursStartHour : 22;
	const end = Number.isInteger(user.quietHoursEndHour) ? user.quietHoursEndHour : 7;
	// B1 — heure de Bruxelles (pas l'heure serveur UTC).
	const hour = brusselsHour(now);
	if (start === end) return false;
	if (start < end) return hour >= start && hour < end;
	// Wraps midnight: e.g. 22-7
	return hour >= start || hour < end;
}

function shortBriefFromDecision(decision) {
	if (!decision) return null;
	if (decision.verdict === "ALL_CLEAR") {
		return {
			title: "Bonne nouvelle",
			body: decision.headline || "Tes lignes habituelles sont fluides ce matin.",
			category: "all_clear",
		};
	}
	if (decision.verdict === "WATCH") {
		return {
			title: "À surveiller",
			body: decision.subhead || decision.headline || "Quelques signalements ponctuels sur tes lignes.",
			category: "watch",
		};
	}
	const cluster = decision.affectedCluster;
	const reco = decision.recommendation;

	let body;
	if (reco?.action && reco?.walkToStop) {
		const eta = reco.viaRoute?.etaMinutes
			? ` ETA ${reco.viaRoute.etaMinutes} min.`
			: "";
		body = `${decision.headline}. Plan B: ${reco.action}.${eta}`;
	} else if (cluster) {
		body = `Ligne ${cluster.ligne}: ${cluster.reportCount} signalements de ${(cluster.typeProbleme || "perturbation").toLowerCase()}. Ouvre l'app pour le verdict.`;
	} else {
		body = decision.headline || "Une perturbation a été détectée sur ton trajet habituel.";
	}

	return {
		title: "Avant de partir",
		body,
		category: decision.verdict.toLowerCase(),
	};
}

async function dispatchPushForUser(user) {
	const decision = await computeDecision({ userId: String(user._id) });

	// Always send a push when triggered, even ALL_CLEAR — it's the daily morning brief.
	const brief = shortBriefFromDecision(decision);
	if (!brief) return { sent: false, reason: "no_brief" };

	if (!user.oneSignalPlayerId) return { sent: false, reason: "no_player_id" };
	if (user.notifications === false) return { sent: false, reason: "notifications_disabled" };
	if (user.preTripPushEnabled === false) return { sent: false, reason: "pretrip_disabled" };
	// B7 — Le brief pré-trajet n'est PAS critique : en mode "Critique seul" ou
	// "Résumé", on ne l'envoie pas (respect du sélecteur de débit).
	if (user.notificationFrequency === "critique" || user.notificationFrequency === "digest") {
		return { sent: false, reason: "frequency_excludes_pretrip" };
	}

	try {
		if (oneSignal?.sendPushToPlayerIds) {
			await oneSignal.sendPushToPlayerIds({
				playerIds: [user.oneSignalPlayerId],
				title: brief.title,
				message: brief.body,
				data: {
					type: "pre_trip_brief",
					verdict: decision.verdict,
					category: brief.category,
					clusterIndex: decision.affectedCluster?.clusterIndex || null,
					line: decision.affectedCluster?.ligne || null,
					recommendedAction: decision.recommendation?.action || null,
				},
			});
		}
		await Utilisateur.findByIdAndUpdate(user._id, { $set: { lastPreTripPushAt: new Date() } });
		return { sent: true, verdict: decision.verdict };
	} catch (pushErr) {
		logger.warn("[pre-trip push]", { detail: `user ${user._id}: ${pushErr.message}` });
		return { sent: false, reason: pushErr.message };
	}
}

async function evaluateAndSendPreTripPushes(now = new Date()) {
	if (isRunning) return { skipped: true, reason: "already_running" };
	isRunning = true;
	const isWeekend = isWeekendWithoutOverride(now);

	try {
		const users = await Utilisateur.find({
			notifications: true,
			preTripPushEnabled: { $ne: false },
			oneSignalPlayerId: { $exists: true, $ne: null },
			"routine.enabled": true,
		})
			.select("_id routine oneSignalPlayerId notifications preTripPushEnabled lastPreTripPushAt notificationFrequency")
			.lean();

		let evaluated = 0;
		let sent = 0;
		let skipped = 0;

		for (const user of users) {
			evaluated += 1;
			if (isWeekend) {
				skipped += 1;
				continue;
			}
			if (isInQuietHours(user, now)) {
				skipped += 1;
				continue;
			}
			if (!isWithinTriggerWindow(user.routine, now)) {
				skipped += 1;
				continue;
			}
			if (alreadyPushedToday(user.lastPreTripPushAt, now)) {
				skipped += 1;
				continue;
			}

			const result = await dispatchPushForUser(user);
			if (result.sent) sent += 1;
			else skipped += 1;
		}

		return { skipped: false, evaluated, sent, skippedCount: skipped };
	} finally {
		isRunning = false;
	}
}

function startPreTripPushLoop() {
	if (process.env.PRE_TRIP_PUSH_ENABLED === "false") return null;
	if (timer) return timer;

	evaluateAndSendPreTripPushes().catch((e) => logger.warn("[pre-trip push] initial run failed:", { error: e.message }));
	timer = setInterval(() => {
		evaluateAndSendPreTripPushes().catch((e) => logger.warn("[pre-trip push] tick failed:", { error: e.message }));
	}, TICK_INTERVAL_MS);
	timer.unref?.();
	logger.info(`✅ Pre-trip push loop started (lead=${TRIGGER_LEAD_MINUTES}min, tick=${TICK_INTERVAL_MS}ms)`);
	return timer;
}

function stopPreTripPushLoop() {
	if (timer) {
		clearInterval(timer);
		timer = null;
	}
}

module.exports = {
	evaluateAndSendPreTripPushes,
	startPreTripPushLoop,
	stopPreTripPushLoop,
	isWithinTriggerWindow,
	alreadyPushedToday,
	shortBriefFromDecision,
};
