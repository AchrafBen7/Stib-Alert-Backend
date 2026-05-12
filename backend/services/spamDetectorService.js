const Signalement = require("../models/Signalement");

const URL_PATTERN = /\bhttps?:\/\/|www\.|\.com\b|\.be\b|\.fr\b|\.net\b/i;
const PHONE_PATTERN = /\b(?:\+?32|0)\s?[0-9]{1,2}\s?[0-9]{2,3}\s?[0-9]{2,3}\s?[0-9]{2,3}\b/;
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const REPEATED_CHARS = /(.)\1{5,}/;

const OFFENSIVE_KEYWORDS = [
	"con", "salope", "pute", "merde", "putain", "fdp", "ntm",
	"fuck", "shit", "asshole", "bitch", "nazi", "hitler",
];

const SPAM_KEYWORDS = [
	"casino", "viagra", "cialis", "crypto", "bitcoin", "btc",
	"discount", "promotion", "offre", "gagnez", "win",
];

const EARTH_RADIUS_M = 6_371_000;

function toRad(deg) {
	return (deg * Math.PI) / 180;
}

function haversineMeters(lat1, lng1, lat2, lng2) {
	if ([lat1, lng1, lat2, lng2].some((v) => v == null || Number.isNaN(v))) {
		return null;
	}
	const dLat = toRad(lat2 - lat1);
	const dLng = toRad(lng2 - lng1);
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(toRad(lat1)) *
			Math.cos(toRad(lat2)) *
			Math.sin(dLng / 2) ** 2;
	return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

function normalize(text) {
	return String(text || "")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s]/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function similarity(a, b) {
	const na = normalize(a);
	const nb = normalize(b);
	if (!na || !nb) return 0;
	if (na === nb) return 1;
	if (na.length < 4 || nb.length < 4) return na === nb ? 1 : 0;

	const tokensA = new Set(na.split(" "));
	const tokensB = new Set(nb.split(" "));
	const intersection = [...tokensA].filter((t) => tokensB.has(t)).length;
	const union = new Set([...tokensA, ...tokensB]).size;
	return union > 0 ? intersection / union : 0;
}

async function findSimilarRecentReports({
	stopId,
	ligne,
	description,
	excludeId = null,
	windowMs = 15 * 60 * 1000,
}) {
	if (!description) return [];

	const since = new Date(Date.now() - windowMs);
	const query = {
		ligne,
		dateSignalement: { $gte: since },
		_id: { $ne: excludeId },
	};
	if (stopId) query.arretId = stopId;

	const candidates = await Signalement.find(query)
		.select("description ligne arretId dateSignalement reporterDeviceHash reporterIpHash")
		.limit(50)
		.lean();

	return candidates
		.map((c) => ({
			...c,
			similarity: similarity(c.description, description),
		}))
		.filter((c) => c.similarity >= 0.85)
		.sort((a, b) => b.similarity - a.similarity);
}

function detectKeywords(text, keywords) {
	const lower = String(text || "").toLowerCase();
	return keywords.filter((kw) => lower.includes(kw));
}

async function scoreSpam({
	description,
	stopId,
	ligne,
	latitude,
	longitude,
	expectedLatitude,
	expectedLongitude,
	reporterDeviceHash,
	authorType,
	createdAt = new Date(),
}) {
	let score = 0;
	const reasons = [];

	const text = String(description || "");
	const trimmed = text.trim();

	if (!trimmed) {
		score += 25;
		reasons.push("empty_description");
	} else {
		if (URL_PATTERN.test(text)) {
			score += 50;
			reasons.push("url_detected");
		}
		if (EMAIL_PATTERN.test(text)) {
			score += 35;
			reasons.push("email_detected");
		}
		if (PHONE_PATTERN.test(text)) {
			score += 20;
			reasons.push("phone_detected");
		}
		if (REPEATED_CHARS.test(text)) {
			score += 15;
			reasons.push("repeated_chars");
		}
		if (trimmed.length < 3) {
			score += 15;
			reasons.push("too_short");
		}
		if (/^[A-Z\s!?.]+$/.test(trimmed) && trimmed.length > 10) {
			score += 10;
			reasons.push("all_caps");
		}

		const spamKw = detectKeywords(text, SPAM_KEYWORDS);
		if (spamKw.length > 0) {
			score += spamKw.length * 20;
			reasons.push(`spam_keywords:${spamKw.join(",")}`);
		}

		const offensiveKw = detectKeywords(text, OFFENSIVE_KEYWORDS);
		if (offensiveKw.length > 0) {
			score += offensiveKw.length * 25;
			reasons.push(`offensive_keywords:${offensiveKw.join(",")}`);
		}
	}

	if (latitude != null && longitude != null && expectedLatitude != null && expectedLongitude != null) {
		const dist = haversineMeters(latitude, longitude, expectedLatitude, expectedLongitude);
		if (dist != null && dist > 500) {
			score += 25;
			reasons.push(`geographic_outlier:${Math.round(dist)}m`);
		}
		if (dist != null && dist > 2000) {
			score += 25;
			reasons.push("geographic_far_outlier");
		}
	}

	if (reporterDeviceHash) {
		const similar = await findSimilarRecentReports({
			stopId,
			ligne,
			description: text,
		});

		if (similar.length > 0) {
			const fromSameDevice = similar.filter(
				(s) => s.reporterDeviceHash === reporterDeviceHash
			);
			if (fromSameDevice.length > 0) {
				score += 60;
				reasons.push(`duplicate_same_device:${fromSameDevice.length}`);
			} else if (similar.length >= 3) {
				score += 30;
				reasons.push(`high_similarity_cluster:${similar.length}`);
			} else {
				score += 15;
				reasons.push(`similar_recent:${similar.length}`);
			}
		}

		const recentByDevice = await Signalement.countDocuments({
			reporterDeviceHash,
			dateSignalement: { $gte: new Date(Date.now() - 5 * 60 * 1000) },
		});
		if (recentByDevice >= 3) {
			score += 30;
			reasons.push(`rapid_fire:${recentByDevice}`);
		}
	}

	if (authorType === "anonymous") {
		score += 5;
		reasons.push("anonymous_reporter");
	}

	score = Math.max(0, Math.min(100, Math.round(score)));

	let recommendation = "approve";
	if (score >= 95) recommendation = "ban";
	else if (score >= 85) recommendation = "reject";
	else if (score >= 70) recommendation = "flag";

	return {
		score,
		recommendation,
		reasons,
		evaluatedAt: createdAt,
	};
}

module.exports = {
	scoreSpam,
	findSimilarRecentReports,
	similarity,
	haversineMeters,
	URL_PATTERN,
	OFFENSIVE_KEYWORDS,
	SPAM_KEYWORDS,
};
