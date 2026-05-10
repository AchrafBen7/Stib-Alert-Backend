const COMMUNITY_ACTION = {
	CONFIRM: "confirm",
	STILL_BLOCKED: "still_blocked",
	RESOLVED: "resolved",
};

const ACTIVE_ACTIONS = [COMMUNITY_ACTION.CONFIRM, COMMUNITY_ACTION.STILL_BLOCKED];
const COMMUNITY_WINDOW_MS = 3 * 60 * 60 * 1000;

function clamp(value, min, max) {
	return Math.min(Math.max(value, min), max);
}

function toDate(value) {
	if (!value) return null;
	if (value instanceof Date) return value;
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function recentCommunityEvents(signalement, now = new Date()) {
	const threshold = now.getTime() - COMMUNITY_WINDOW_MS;
	return (signalement.communityEvents || []).filter((event) => {
		const createdAt = toDate(event.createdAt);
		return createdAt && createdAt.getTime() >= threshold;
	});
}

function groupCommunityCounts(events) {
	return events.reduce((acc, event) => {
		const key = event.action || COMMUNITY_ACTION.CONFIRM;
		acc[key] = (acc[key] || 0) + 1;
		return acc;
	}, {
		[COMMUNITY_ACTION.CONFIRM]: 0,
		[COMMUNITY_ACTION.STILL_BLOCKED]: 0,
		[COMMUNITY_ACTION.RESOLVED]: 0,
	});
}

function legacyConfidenceBase(value) {
	switch (String(value || "").toLowerCase()) {
	case "haute":
	case "high":
		return 0.84;
	case "moyenne":
	case "medium":
		return 0.68;
	case "basse":
	case "low":
		return 0.52;
	default:
		return 0.58;
	}
}

function deriveCommunityStatus(signalement, now = new Date()) {
	const events = recentCommunityEvents(signalement, now);
	const counts = groupCommunityCounts(events);
	const activeScore = counts.confirm + counts.still_blocked * 1.2 + (signalement.votesPositifs || 0) * 0.12;
	const resolvedScore = counts.resolved * 1.25 + (signalement.votesNegatifs || 0) * 0.1;

	const status = counts.resolved >= 3 && counts.resolved >= counts.still_blocked
		? "resolved"
		: resolvedScore > activeScore + 0.75 ? "resolved" : "active";
	const freshnessMinutes = (() => {
		const sourceDate = toDate(signalement.dateSignalement);
		if (!sourceDate) return 180;
		return Math.max((now.getTime() - sourceDate.getTime()) / 60000, 0);
	})();
	const freshnessFactor = freshnessMinutes <= 10
		? 1
		: freshnessMinutes <= 30
			? 0.92
			: freshnessMinutes <= 90
				? 0.78
				: 0.62;

	const communityBoost = clamp(
		counts.confirm * 0.04 +
		counts.still_blocked * 0.05 -
		counts.resolved * 0.08 +
		(signalement.votesPositifs || 0) * 0.015 -
		(signalement.votesNegatifs || 0) * 0.03,
		-0.24,
		0.28
	);

	let confidence = legacyConfidenceBase(signalement.confiance) * freshnessFactor + communityBoost;
	if (status === "resolved") {
		confidence -= 0.14;
	}
	confidence = clamp(confidence, 0.2, 0.98);

	return {
		status,
		confidence,
		freshnessMinutes,
		counts,
		activeScore,
		resolvedScore,
	};
}

function buildCommunityMeta(signalement, now = new Date()) {
	const summary = deriveCommunityStatus(signalement, now);
	return {
		status: summary.status,
		confidence: summary.confidence,
		freshnessMinutes: Math.round(summary.freshnessMinutes),
		confirmations: summary.counts.confirm,
		stillBlocked: summary.counts.still_blocked,
		resolved: summary.counts.resolved,
	};
}

function upsertCommunityAction(signalement, actor, action, now = new Date()) {
	const events = Array.isArray(signalement.communityEvents) ? [...signalement.communityEvents] : [];
	const normalizedUserId = actor?.userId ? String(actor.userId) : null;
	const normalizedActorHash = actor?.actorHash ? String(actor.actorHash) : null;

	const filtered = events.filter((event) => {
		if (normalizedUserId) return String(event.userId || "") !== normalizedUserId;
		if (normalizedActorHash) return String(event.actorHash || "") !== normalizedActorHash;
		return true;
	});

	filtered.push({
		userId: normalizedUserId || undefined,
		actorHash: normalizedActorHash || undefined,
		action,
		createdAt: now,
	});

	signalement.communityEvents = filtered;
	const summary = deriveCommunityStatus(signalement, now);
	signalement.status = summary.status;
	return summary;
}

module.exports = {
	COMMUNITY_ACTION,
	ACTIVE_ACTIONS,
	buildCommunityMeta,
	deriveCommunityStatus,
	upsertCommunityAction,
};
