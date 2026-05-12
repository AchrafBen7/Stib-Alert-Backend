const DeviceLimit = require("../models/DeviceLimit");

const LIMITS = {
	// Baseline (anonymous / new devices).
	REPORTS_PER_HOUR: 5,
	REPORTS_PER_DAY: 20,
	SAME_STOP_PER_HOUR: 2,
	SAME_LINE_PER_HOUR: 3,
	MIN_INTERVAL_SECONDS: 15,

	// Trusted users get a wider lane so a daily commuter signaling
	// 3 problems in 20 min on different stops doesn't hit limits.
	TRUSTED_REPORTS_PER_HOUR: 12,
	TRUSTED_REPORTS_PER_DAY: 50,
	TRUSTED_SAME_LINE_PER_HOUR: 6,
	TRUSTED_MIN_INTERVAL_SECONDS: 8,

	TEMP_BAN_HOURS: 24,
	TEMP_BAN_THRESHOLD_FLAGS: 10,
	PERM_BAN_THRESHOLD_FLAGS: 50,
};

// A "trusted" reporter has: authenticated account >= 7 days old,
// at least 3 prior successful reports, no spam flags.
function computeTrustMultiplier(device, { userId } = {}) {
	if (!userId) return 1;
	const accountAge = device?.firstSeenAt
		? (Date.now() - new Date(device.firstSeenAt).getTime()) / 86_400_000
		: 0;
	const goodHistory = (device?.successfulReportCount || 0) >= 3;
	const noSpam = (device?.spamFlagCount || 0) === 0;

	if (accountAge >= 7 && goodHistory && noSpam) return "trusted";
	if (accountAge >= 1 && noSpam) return "warm";
	return 1;
}

function effectiveLimits(trustTier) {
	if (trustTier === "trusted") {
		return {
			hourly: LIMITS.TRUSTED_REPORTS_PER_HOUR,
			daily: LIMITS.TRUSTED_REPORTS_PER_DAY,
			sameStopHourly: LIMITS.SAME_STOP_PER_HOUR + 1,
			sameLineHourly: LIMITS.TRUSTED_SAME_LINE_PER_HOUR,
			minInterval: LIMITS.TRUSTED_MIN_INTERVAL_SECONDS,
		};
	}
	if (trustTier === "warm") {
		return {
			hourly: LIMITS.REPORTS_PER_HOUR + 2,
			daily: LIMITS.REPORTS_PER_DAY + 10,
			sameStopHourly: LIMITS.SAME_STOP_PER_HOUR,
			sameLineHourly: LIMITS.SAME_LINE_PER_HOUR + 1,
			minInterval: LIMITS.MIN_INTERVAL_SECONDS,
		};
	}
	return {
		hourly: LIMITS.REPORTS_PER_HOUR,
		daily: LIMITS.REPORTS_PER_DAY,
		sameStopHourly: LIMITS.SAME_STOP_PER_HOUR,
		sameLineHourly: LIMITS.SAME_LINE_PER_HOUR,
		minInterval: LIMITS.MIN_INTERVAL_SECONDS,
	};
}

function isTestEnv() {
	return process.env.NODE_ENV === "test";
}

function nowMs() {
	return Date.now();
}

async function getOrCreateDeviceLimit(deviceHash) {
	if (!deviceHash) return null;
	let device = await DeviceLimit.findById(deviceHash);
	if (!device) {
		device = new DeviceLimit({
			_id: deviceHash,
			reportCount24h: 0,
			reportCountHour: 0,
			lastReportTimestamps: [],
			firstSeenAt: new Date(),
		});
	}
	return device;
}

function countInWindow(timestamps, windowMs, ref = nowMs()) {
	if (!Array.isArray(timestamps)) return 0;
	const threshold = ref - windowMs;
	return timestamps.filter((t) => {
		const ms = t instanceof Date ? t.getTime() : new Date(t).getTime();
		return Number.isFinite(ms) && ms >= threshold;
	}).length;
}

function recentByStop(device, stopId, windowMs, ref = nowMs()) {
	if (!stopId || !Array.isArray(device.lastStopsReported)) return 0;
	const count = device.lastStopsReported.filter((s) => s === stopId).length;
	return count;
}

async function checkLimit({ deviceHash, ipHash, stopId, lineId, userId = null }) {
	if (isTestEnv()) {
		return { allowed: true, reason: null };
	}

	if (!deviceHash) {
		return {
			allowed: false,
			reason: "missing_device_id",
			message: "Identifiant d'appareil requis.",
			retryAfterSeconds: 0,
		};
	}

	const device = await getOrCreateDeviceLimit(deviceHash);

	if (device.isCurrentlyBanned()) {
		const retrySec = device.banExpiresAt
			? Math.max(0, Math.ceil((device.banExpiresAt.getTime() - nowMs()) / 1000))
			: 24 * 60 * 60;
		return {
			allowed: false,
			reason: "device_banned",
			message: device.banReason || "Appareil temporairement bloqué.",
			retryAfterSeconds: retrySec,
		};
	}

	const trustTier = computeTrustMultiplier(device, { userId });
	const limits = effectiveLimits(trustTier);

	const now = nowMs();
	const lastTimestampMs = device.lastReportTimestamps.length > 0
		? new Date(device.lastReportTimestamps[device.lastReportTimestamps.length - 1]).getTime()
		: 0;

	if (lastTimestampMs && now - lastTimestampMs < limits.minInterval * 1000) {
		return {
			allowed: false,
			reason: "min_interval",
			message: `Attendez ${limits.minInterval} secondes entre deux signalements.`,
			retryAfterSeconds: Math.ceil(
				(limits.minInterval * 1000 - (now - lastTimestampMs)) / 1000
			),
			trustTier,
		};
	}

	const hourlyCount = countInWindow(device.lastReportTimestamps, 60 * 60 * 1000);
	if (hourlyCount >= limits.hourly) {
		return {
			allowed: false,
			reason: "rate_limit_hour",
			message: `Trop de signalements (${hourlyCount}/${limits.hourly} cette heure). Réessayez plus tard.`,
			retryAfterSeconds: 600,
			trustTier,
		};
	}

	if (device.reportCount24h >= limits.daily) {
		return {
			allowed: false,
			reason: "rate_limit_day",
			message: `Limite quotidienne atteinte (${limits.daily} signalements).`,
			retryAfterSeconds: 60 * 60,
			trustTier,
		};
	}

	if (stopId) {
		const sameStopHourly = recentByStop(device, String(stopId), 60 * 60 * 1000);
		if (sameStopHourly >= limits.sameStopHourly) {
			return {
				allowed: false,
				reason: "rate_limit_stop",
				message: "Vous avez déjà signalé cet arrêt récemment.",
				retryAfterSeconds: 30 * 60,
				trustTier,
			};
		}
	}

	if (lineId) {
		const sameLineHourly = device.lastLineIds.filter((l) => l === String(lineId)).length;
		if (sameLineHourly >= limits.sameLineHourly) {
			return {
				allowed: false,
				reason: "rate_limit_line",
				message: "Vous avez déjà signalé cette ligne plusieurs fois récemment.",
				retryAfterSeconds: 30 * 60,
				trustTier,
			};
		}
	}

	return { allowed: true, reason: null, device, trustTier };
}

async function recordReport({ deviceHash, stopId, lineId }) {
	if (!deviceHash) return null;
	const device = await getOrCreateDeviceLimit(deviceHash);
	const now = new Date();
	device.pushTimestamp(now);
	if (stopId) device.pushStop(String(stopId));
	if (lineId) device.pushLine(String(lineId));
	device.reportCount24h = countInWindow(device.lastReportTimestamps, 24 * 60 * 60 * 1000);
	device.reportCountHour = countInWindow(device.lastReportTimestamps, 60 * 60 * 1000);
	device.successfulReportCount = (device.successfulReportCount || 0) + 1;
	await device.save();
	return device;
}

async function incrementSpamFlag(deviceHash, { reason = "spam_flag" } = {}) {
	if (!deviceHash) return null;
	const device = await getOrCreateDeviceLimit(deviceHash);
	device.spamFlagCount = (device.spamFlagCount || 0) + 1;

	if (device.spamFlagCount >= LIMITS.PERM_BAN_THRESHOLD_FLAGS && !device.isBanned) {
		device.isBanned = true;
		device.banReason = `Banned (permanent): ${reason}`;
		device.bannedAt = new Date();
		device.banExpiresAt = null;
	} else if (
		device.spamFlagCount >= LIMITS.TEMP_BAN_THRESHOLD_FLAGS &&
		!device.isBanned
	) {
		device.isBanned = true;
		device.banReason = `Banned (24h): ${reason}`;
		device.bannedAt = new Date();
		device.banExpiresAt = new Date(Date.now() + LIMITS.TEMP_BAN_HOURS * 60 * 60 * 1000);
	}

	await device.save();
	return device;
}

async function banDevice(deviceHash, { hours = 24, reason = "manual_ban" } = {}) {
	if (!deviceHash) return null;
	const device = await getOrCreateDeviceLimit(deviceHash);
	device.isBanned = true;
	device.banReason = reason;
	device.bannedAt = new Date();
	device.banExpiresAt = hours ? new Date(Date.now() + hours * 60 * 60 * 1000) : null;
	await device.save();
	return device;
}

async function unbanDevice(deviceHash) {
	if (!deviceHash) return null;
	const device = await DeviceLimit.findById(deviceHash);
	if (!device) return null;
	device.isBanned = false;
	device.banReason = null;
	device.banExpiresAt = null;
	await device.save();
	return device;
}

module.exports = {
	LIMITS,
	checkLimit,
	recordReport,
	incrementSpamFlag,
	banDevice,
	unbanDevice,
	getOrCreateDeviceLimit,
};
