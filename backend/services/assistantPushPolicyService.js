const AssistantNotificationLog = require("../models/AssistantNotificationLog");
const Utilisateur = require("../models/Utilisateur");
const { sendNotificationWithDeepLink } = require("./oneSignalService");
const { isInQuietHours } = require("./pushPreferences");

const POLICY_BY_TYPE = {
	commute_detour: { cooldownMinutes: 10, priority: "high" },
	commute_leave_now: { cooldownMinutes: 15, priority: "elevated" },
	commute_prepare: { cooldownMinutes: 25, priority: "normal" },
	commute_wait: { cooldownMinutes: 20, priority: "normal" },
	commute_watch: { cooldownMinutes: 45, priority: "normal" },
};

function resolveCommuteNotificationType(brief) {
	const decision = brief?.supporting?.commuteDecision || "watch";
	switch (decision) {
	case "detour":
		return "commute_detour";
	case "leave_now":
		return "commute_leave_now";
	case "prepare":
		return "commute_prepare";
	case "wait":
		return "commute_wait";
	default:
		return "commute_watch";
	}
}

function buildContextKey({ brief, preferredStopId = null }) {
	const stage = brief?.supporting?.briefingStage || "default";
	const decision = brief?.supporting?.commuteDecision || "watch";
	const stopKey = preferredStopId || "default-stop";
	return `${stopKey}:${decision}:${stage}`;
}

async function findRecentLog({ userId, type, contextKey, cooldownMinutes }) {
	const threshold = new Date(Date.now() - cooldownMinutes * 60 * 1000);
	return AssistantNotificationLog.findOne({
		userId,
		type,
		contextKey,
		sentAt: { $gte: threshold },
	})
		.sort({ sentAt: -1 })
		.lean();
}

async function sendManagedCommutePush({ userId, brief, preferredStopId = null }) {
	// Safety net for the (legacy) assistant push path, which had no gating:
	// honour the master switch + the silent window. Stibi is otherwise retired
	// from the app, and this loop only runs via the separate assistant worker.
	const prefs = await Utilisateur.findById(userId)
		.select("notifications quietHoursEnabled quietHoursStartHour quietHoursEndHour")
		.lean();
	if (!prefs || prefs.notifications === false || isInQuietHours(prefs)) {
		return { sent: false, skipped: true, reason: "preference_disabled" };
	}

	const type = resolveCommuteNotificationType(brief);
	const policy = POLICY_BY_TYPE[type] || POLICY_BY_TYPE.commute_watch;
	const contextKey = buildContextKey({ brief, preferredStopId });

	const recent = await findRecentLog({
		userId,
		type,
		contextKey,
		cooldownMinutes: policy.cooldownMinutes,
	});

	if (recent && recent.title === brief.title && recent.message === brief.message) {
		return {
			sent: false,
			skipped: true,
			reason: "cooldown_active",
			priority: policy.priority,
			type,
		};
	}

	const alternatives = brief.supporting?.recommendedAlternatives || [];
	const best = alternatives[0];

	await sendNotificationWithDeepLink({
		userId: String(userId),
		title: brief.title,
		message: brief.message,
		type: `stibi_${type}`,
		id: best?.type || brief.supporting?.commuteDecision || "brief",
		deepLink: `stibalert://stibi/commute/${best?.type || brief.supporting?.commuteDecision || "brief"}`,
	});

	await AssistantNotificationLog.create({
		userId,
		type,
		contextKey,
		priority: policy.priority,
		title: brief.title,
		message: brief.message,
		decision: brief.supporting?.commuteDecision || null,
		stage: brief.supporting?.briefingStage || null,
		sentAt: new Date(),
	});

	return {
		sent: true,
		skipped: false,
		priority: policy.priority,
		type,
	};
}

module.exports = {
	sendManagedCommutePush,
};
