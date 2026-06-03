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

	// Facteur P (proximité) — un témoin SUR PLACE est bien plus fiable qu'un
	// signalement posté à plusieurs km de l'arrêt. C'était le facteur de la
	// formule de confiance documentée totalement absent du score jusqu'ici.
	BONUS_PROXIMITY_ONSITE: 12,   // < 250 m : clairement à l'arrêt
	BONUS_PROXIMITY_NEAR: 5,      // < 600 m : dans le coin
	PENALTY_PROXIMITY_FAR: -12,   // > 3 km : ne peut pas témoigner directement

	PENALTY_DEVICE_SUSPICIOUS: -15,
	PENALTY_DEVICE_NEW: -10,
	PENALTY_RECENT_REJECTION: -10,

	MIN: 0,
	MAX: 100,
};

// Seuils de distance (km) pour le facteur proximité.
const PROXIMITY_ONSITE_KM = 0.25;
const PROXIMITY_NEAR_KM = 0.6;
const PROXIMITY_FAR_KM = 3;

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
	// Facteur P — distance témoin↔arrêt en km (null si inconnue).
	reporterDistanceKm = null,
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

	// Facteur P (proximité) — appliqué dès qu'on connaît la distance.
	if (Number.isFinite(reporterDistanceKm)) {
		if (reporterDistanceKm <= PROXIMITY_ONSITE_KM) {
			trust += TRUST.BONUS_PROXIMITY_ONSITE;
			breakdown.bonuses.push(`proximity_onsite:${Math.round(reporterDistanceKm * 1000)}m`);
		} else if (reporterDistanceKm <= PROXIMITY_NEAR_KM) {
			trust += TRUST.BONUS_PROXIMITY_NEAR;
			breakdown.bonuses.push(`proximity_near:${Math.round(reporterDistanceKm * 1000)}m`);
		} else if (reporterDistanceKm >= PROXIMITY_FAR_KM) {
			trust += TRUST.PENALTY_PROXIMITY_FAR;
			breakdown.penalties.push(`proximity_far:${reporterDistanceKm.toFixed(1)}km`);
		}
	}

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

// Confiance agrégée d'un cluster = MOYENNE PONDÉRÉE PAR LE TRUST des témoins,
// pas une moyenne simple.
//
// Pourquoi : avec une moyenne simple, 3 comptes douteux (trust 40) + 1 témoin
// fiable sur place (trust 90) donnaient (40·3+90)/4 = 52 → le vrai témoin était
// "noyé" par le bruit. En vie réelle, un signalement crédible ne devrait pas
// être affaibli par des contributions faibles.
//
// Formule : Σ(tᵢ²) / Σ(tᵢ). Chaque témoin pèse proportionnellement à sa propre
// fiabilité → le signal fort domine, le bruit faible tempère sans écraser.
// Sur l'exemple ci-dessus : (3·40² + 90²)/(3·40 + 90) = 12900/210 ≈ 61.
// La corroboration (nombre de témoins) reste gérée séparément par
// deriveConfidence / les seuils de publication — on ne la double pas ici.
async function calculateAggregateTrust(signalementIds) {
	if (!Array.isArray(signalementIds) || signalementIds.length === 0) {
		return TRUST.BASE_GUEST;
	}

	const reports = await Signalement.find({ _id: { $in: signalementIds } })
		.select("trust")
		.lean();

	if (reports.length === 0) return TRUST.BASE_GUEST;

	let weightedSum = 0; // Σ(tᵢ²)
	let weightTotal = 0; // Σ(tᵢ)
	for (const r of reports) {
		const t = Number.isFinite(r.trust) ? r.trust : TRUST.BASE_GUEST;
		weightedSum += t * t;
		weightTotal += t;
	}

	if (weightTotal <= 0) return TRUST.BASE_GUEST;
	return clamp(Math.round(weightedSum / weightTotal));
}

module.exports = {
	TRUST,
	calculateTrust,
	calculateUserAccuracy,
	calculateAggregateTrust,
};
