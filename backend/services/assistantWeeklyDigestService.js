const Utilisateur = require("../models/Utilisateur");
const Signalement = require("../models/Signalement");
const AssistantNotificationLog = require("../models/AssistantNotificationLog");
const { sendNotificationWithDeepLink } = require("./oneSignalService");

let isRunning = false;

function startOfWeek(date) {
	const copy = new Date(date);
	const day = copy.getUTCDay();
	const diff = day === 0 ? 6 : day - 1;
	copy.setUTCDate(copy.getUTCDate() - diff);
	copy.setUTCHours(0, 0, 0, 0);
	return copy;
}

async function alreadySentThisWeek(userId, weekKey) {
	const existing = await AssistantNotificationLog.findOne({
		userId,
		type: "weekly_digest",
		contextKey: weekKey,
	}).lean();
	return Boolean(existing);
}

async function buildWeeklyDigest(user) {
	const favoriteLines = (user.favoriteLines || []).map((line) => String(line || "").trim().toUpperCase()).filter(Boolean);
	if (!favoriteLines.length) return null;

	const now = new Date();
	const currentWeekStart = startOfWeek(now);
	const previousWeekStart = new Date(currentWeekStart);
	previousWeekStart.setUTCDate(previousWeekStart.getUTCDate() - 7);

	const [currentWeek, previousWeek] = await Promise.all([
		Signalement.find({
			ligne: { $in: favoriteLines },
			dateSignalement: { $gte: currentWeekStart },
		}).select("ligne").lean(),
		Signalement.find({
			ligne: { $in: favoriteLines },
			dateSignalement: { $gte: previousWeekStart, $lt: currentWeekStart },
		}).select("ligne").lean(),
	]);

	if (!currentWeek.length) return null;

	const counts = currentWeek.reduce((acc, item) => {
		const line = String(item.ligne || "").toUpperCase();
		acc[line] = (acc[line] || 0) + 1;
		return acc;
	}, {});

	const previousCounts = previousWeek.reduce((acc, item) => {
		const line = String(item.ligne || "").toUpperCase();
		acc[line] = (acc[line] || 0) + 1;
		return acc;
	}, {});

	const [topLine, topCount] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
	const previousCount = previousCounts[topLine] || 0;
	const delta = previousCount > 0
		? Math.round(((topCount - previousCount) / previousCount) * 100)
		: null;

	return {
		weekKey: `${currentWeekStart.toISOString().slice(0, 10)}:${topLine}`,
		title: `Digest hebdo • ligne ${topLine}`,
		message: delta !== null
			? `Ta ligne ${topLine} a eu ${topCount} perturbations cette semaine (${delta >= 0 ? "+" : ""}${delta} % vs semaine dernière).`
			: `Ta ligne ${topLine} a eu ${topCount} perturbations cette semaine.`,
		deepLink: `stibalert://signalements/line/${topLine}`,
	};
}

async function evaluateAndSendWeeklyDigests() {
	if (isRunning) return { skipped: true, reason: "already_running" };
	isRunning = true;
	try {
		const users = await Utilisateur.find({
			notifications: true,
			weeklyDigestEnabled: true,
			oneSignalPlayerId: { $exists: true, $ne: null },
			favoriteLines: { $exists: true, $not: { $size: 0 } },
		})
			.select("_id favoriteLines")
			.lean();

		let evaluated = 0;
		let sent = 0;

		for (const user of users) {
			evaluated += 1;
			const digest = await buildWeeklyDigest(user);
			if (!digest) continue;
			if (await alreadySentThisWeek(user._id, digest.weekKey)) continue;

			await sendNotificationWithDeepLink({
				userId: String(user._id),
				title: digest.title,
				message: digest.message,
				type: "weekly_digest",
				id: digest.weekKey,
				deepLink: digest.deepLink,
			});

			await AssistantNotificationLog.create({
				userId: user._id,
				type: "weekly_digest",
				contextKey: digest.weekKey,
				priority: "normal",
				title: digest.title,
				message: digest.message,
				sentAt: new Date(),
			});
			sent += 1;
		}

		return { skipped: false, evaluated, sent };
	} finally {
		isRunning = false;
	}
}

function startAssistantWeeklyDigestLoop() {
	const intervalHours = Number(process.env.ASSISTANT_WEEKLY_DIGEST_INTERVAL_HOURS || 0);
	if (!Number.isFinite(intervalHours) || intervalHours <= 0) {
		return null;
	}

	const intervalMs = intervalHours * 60 * 60 * 1000;
	const timer = setInterval(() => {
		evaluateAndSendWeeklyDigests()
			.then((result) => {
				if (!result?.skipped) {
					console.log("[assistant weekly digest]", result);
				}
			})
			.catch((error) => {
				console.error("[assistant weekly digest]", error.message);
			});
	}, intervalMs);

	timer.unref?.();
	console.log(`[assistant weekly digest] loop enabled every ${intervalHours}h`);
	return timer;
}

module.exports = {
	evaluateAndSendWeeklyDigests,
	startAssistantWeeklyDigestLoop,
};
