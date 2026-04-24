const Signalement = require("../models/Signalement");
const StopFragilitySnapshot = require("../models/StopFragilitySnapshot");
const cache = require("./memoryCache");
const { buildCommunityMeta } = require("./signalementCommunityService");
const { severityFromSignalement, SEVERITY } = require("./transportSeverity");

const WINDOW_DAYS = 21;
const TTL_MS = 30 * 60 * 1000;

function severityWeight(severity) {
	switch (severity) {
	case SEVERITY.CRITICAL: return 20;
	case SEVERITY.MAJOR: return 12;
	case SEVERITY.MINOR: return 5;
	default: return 0;
	}
}

function normalize(value) {
	return String(value || "").trim().toLowerCase();
}

function stableKey(prefix, payload) {
	return `${prefix}:${JSON.stringify(payload)}`;
}

async function buildSnapshotsForHour({ lines = [], hourBucket }) {
	const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
	const query = {
		dateSignalement: { $gte: since },
	};
	if (lines.length) {
		query.ligne = { $in: lines };
	}

	const signalements = await Signalement.find(query)
		.populate("arretId")
		.lean();

	const grouped = new Map();

	for (const signalement of signalements) {
		const stopNameLower = normalize(signalement.arretId?.nom);
		if (!stopNameLower) continue;

		const signalementHour = new Date(signalement.dateSignalement || Date.now()).getHours();
		const hourDelta = Math.abs(signalementHour - hourBucket);
		if (hourDelta > 2 && hourDelta < 22) continue;

		const hourWeight = hourDelta === 0 ? 1 : hourDelta === 1 ? 0.72 : 0.4;
		const community = buildCommunityMeta(signalement);
		const severity = severityFromSignalement(signalement);
		const confirmations = community.confirmations || 0;
		const stillBlocked = community.stillBlocked || 0;
		const resolved = community.resolved || 0;
		const scoreContribution =
			severityWeight(severity)
			* hourWeight
			* (community.confidence || 0.55)
			* (1 + Math.min((confirmations + stillBlocked) * 0.04, 0.3))
			* (community.status === "resolved" ? 0.35 : 1);

		const key = `${stopNameLower}:${signalement.ligne || ""}`;
		const current = grouped.get(key) || {
			stopId: signalement.arretId?._id || null,
			stopNameLower,
			line: signalement.ligne || null,
			hourBucket,
			score: 0,
			signalCount: 0,
			confirmations: 0,
			stillBlocked: 0,
			resolved: 0,
			windowDays: WINDOW_DAYS,
			lastSignalementAt: signalement.dateSignalement || null,
		};

		current.score += scoreContribution;
		current.signalCount += 1;
		current.confirmations += confirmations;
		current.stillBlocked += stillBlocked;
		current.resolved += resolved;
		if (signalement.dateSignalement && (!current.lastSignalementAt || signalement.dateSignalement > current.lastSignalementAt)) {
			current.lastSignalementAt = signalement.dateSignalement;
		}
		grouped.set(key, current);
	}

	return Array.from(grouped.values());
}

async function computeAndPersistSnapshots({ lines = [], hourBucket = new Date().getHours() }) {
	const snapshots = await buildSnapshotsForHour({ lines, hourBucket });
	if (!snapshots.length) {
		return [];
	}

	await Promise.all(
		snapshots.map((snapshot) =>
			StopFragilitySnapshot.findOneAndUpdate(
				{
					stopNameLower: snapshot.stopNameLower,
					hourBucket: snapshot.hourBucket,
					line: snapshot.line,
				},
				snapshot,
				{ upsert: true, new: true, setDefaultsOnInsert: true }
			)
		)
	);

	return snapshots;
}

async function getFragilitySnapshots({ lines = [], hourBucket = new Date().getHours() }) {
	const normalizedLines = lines.map((line) => String(line).trim()).filter(Boolean);

	return cache.remember(
		stableKey("stop-fragility", { lines: normalizedLines.slice().sort(), hourBucket }),
		TTL_MS,
		async () => {
			const existing = await StopFragilitySnapshot.find({
				hourBucket,
				...(normalizedLines.length ? { line: { $in: normalizedLines } } : {}),
			}).lean();

			if (existing.length) {
				return existing;
			}

			return computeAndPersistSnapshots({ lines: normalizedLines, hourBucket });
		}
	);
}

module.exports = {
	getFragilitySnapshots,
	computeAndPersistSnapshots,
};
