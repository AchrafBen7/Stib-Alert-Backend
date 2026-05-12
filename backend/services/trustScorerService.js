const Signalement = require("../models/Signalement");
const DeviceLimit = require("../models/DeviceLimit");

const TRUST = {
	BASE_GUEST: 50,
	BASE_USER: 75,
	BASE_NEW_DEVICE: 40,
	BASE_OFFICIAL: 100,

	BONUS_VERIFIED_USER: 10,
	BONUS_ACCOUNT_AGE_30D: 5,
	BONUS_DEVICE_TRUSTED: 10,
	BONUS_HISTORICAL_ACCURACY: 10,

	PENALTY_DEVICE_SUSPICIOUS: -15,
	PENALTY_DEVICE_NEW: -10,
	PENALTY_RECENT_REJECTION: -10,

	MIN: 0,
	MAX: 100,
};

const NEW_DEVICE_AGE_MS = 24 * 60 * 60 * 1000;
const TRUSTED_DEVICE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const ACCOUNT_AGE_BONUS_MS = 30 * 24 * 60 * 60 * 1000;

function clamp(value, min = TRUST.MIN, max = TRUST.MAX) {
	return Math.max(min, Math.min(max, value));
}

async function calculateTrust({
	utilisateurId,
	user = null,
	authorType = "anonymous",
	reporterDeviceHash = null,
	source = "community",
}) {
	const breakdown = {
		baseScore: 0,
		bonuses: [],
		penalties: [],
	};

	if (source === "stib_officiel" || authorType === "official") {
		breakdown.baseScore = TRUST.BASE_OFFICIAL;
		breakdown.bonuses.push("official_source");
		return {
			score: TRUST.BASE_OFFICIAL,
			breakdown,
		};
	}

	let trust = utilisateurId || user ? TRUST.BASE_USER : TRUST.BASE_GUEST;
	breakdown.baseScore = trust;

	if (utilisateurId || user) {
		breakdown.bonuses.push("logged_in");

		const userDoc = user || null;
		if (userDoc?.createdAt && Date.now() - new Date(userDoc.createdAt).getTime() > ACCOUNT_AGE_BONUS_MS) {
			trust += TRUST.BONUS_ACCOUNT_AGE_30D;
			breakdown.bonuses.push("account_age_30d");
		}

		if (userDoc?.emailVerified === true || userDoc?.isVerified === true) {
			trust += TRUST.BONUS_VERIFIED_USER;
			breakdown.bonuses.push("email_verified");
		}

		if (utilisateurId) {
			const userAccuracy = await calculateUserAccuracy(utilisateurId);
			if (userAccuracy >= 0.8) {
				trust += TRUST.BONUS_HISTORICAL_ACCURACY;
				breakdown.bonuses.push(`historical_accuracy:${Math.round(userAccuracy * 100)}%`);
			} else if (userAccuracy < 0.4 && userAccuracy >= 0) {
				trust -= 10;
				breakdown.penalties.push(`low_accuracy:${Math.round(userAccuracy * 100)}%`);
			}
		}
	}

	if (reporterDeviceHash) {
		const device = await DeviceLimit.findById(reporterDeviceHash).lean();
		if (device) {
			const deviceAgeMs = Date.now() - new Date(device.firstSeenAt).getTime();

			if (deviceAgeMs < NEW_DEVICE_AGE_MS) {
				trust += TRUST.PENALTY_DEVICE_NEW;
				breakdown.penalties.push("device_new");
			} else if (deviceAgeMs > TRUSTED_DEVICE_AGE_MS && device.spamFlagCount < 2) {
				trust += TRUST.BONUS_DEVICE_TRUSTED;
				breakdown.bonuses.push("device_trusted");
			}

			if ((device.spamFlagCount || 0) >= 3) {
				trust += TRUST.PENALTY_DEVICE_SUSPICIOUS;
				breakdown.penalties.push(`spam_flags:${device.spamFlagCount}`);
			}

			if ((device.moderationRejectionCount || 0) >= 2) {
				trust += TRUST.PENALTY_RECENT_REJECTION;
				breakdown.penalties.push(`rejections:${device.moderationRejectionCount}`);
			}
		} else if (!utilisateurId) {
			trust = Math.min(trust, TRUST.BASE_NEW_DEVICE);
			breakdown.penalties.push("device_unknown");
		}
	}

	const finalScore = clamp(Math.round(trust));

	return {
		score: finalScore,
		breakdown,
	};
}

async function calculateUserAccuracy(utilisateurId) {
	if (!utilisateurId) return -1;

	const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
	const reports = await Signalement.find({
		utilisateurId,
		createdAt: { $gte: since },
	})
		.select("status moderationStatus votesPositifs votesNegatifs")
		.lean();

	if (reports.length === 0) return -1;

	const totalReports = reports.length;
	const approvedReports = reports.filter((r) => r.moderationStatus === "approved").length;
	const positiveVotes = reports.reduce((sum, r) => sum + (r.votesPositifs || 0), 0);
	const negativeVotes = reports.reduce((sum, r) => sum + (r.votesNegatifs || 0), 0);

	const moderationAccuracy = approvedReports / totalReports;
	const voteAccuracy = positiveVotes + negativeVotes > 0
		? positiveVotes / (positiveVotes + negativeVotes)
		: 0.5;

	return moderationAccuracy * 0.6 + voteAccuracy * 0.4;
}

async function calculateAggregateTrust(signalementIds) {
	if (!Array.isArray(signalementIds) || signalementIds.length === 0) {
		return TRUST.BASE_GUEST;
	}

	const reports = await Signalement.find({ _id: { $in: signalementIds } })
		.select("trust")
		.lean();

	if (reports.length === 0) return TRUST.BASE_GUEST;

	const sum = reports.reduce((acc, r) => acc + (Number.isFinite(r.trust) ? r.trust : TRUST.BASE_GUEST), 0);
	return Math.round(sum / reports.length);
}

module.exports = {
	TRUST,
	calculateTrust,
	calculateUserAccuracy,
	calculateAggregateTrust,
};
