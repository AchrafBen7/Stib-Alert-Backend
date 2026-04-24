const Utilisateur = require("../models/Utilisateur");
const { getCommuteBrief } = require("./assistantService");
const { sendManagedCommutePush } = require("./assistantPushPolicyService");

let isRunning = false;

async function evaluateAndSendProactiveCommutePushes() {
	if (isRunning) {
		return { skipped: true, reason: "already_running" };
	}

	isRunning = true;
	try {
		const users = await Utilisateur.find({
			notifications: true,
			oneSignalPlayerId: { $exists: true, $ne: null },
			"routine.enabled": true,
		})
			.select("_id routine oneSignalPlayerId notifications")
			.lean();

		let evaluated = 0;
		let sent = 0;
		let skipped = 0;

		for (const user of users) {
			evaluated += 1;
			try {
				const preferredStopId = user.routine?.homeStopId || null;
				const brief = await getCommuteBrief({
					userId: user._id,
					preferredStopId,
				});
				const delivery = await sendManagedCommutePush({
					userId: user._id,
					brief,
					preferredStopId,
				});
				if (delivery.sent) {
					sent += 1;
				} else {
					skipped += 1;
				}
			} catch (error) {
				skipped += 1;
				console.warn("[assistant proactive push]", `user ${user._id}: ${error.message}`);
			}
		}

		return {
			skipped: false,
			evaluated,
			sent,
			skippedCount: skipped,
		};
	} finally {
		isRunning = false;
	}
}

function startAssistantProactivePushLoop() {
	const intervalMinutes = Number(process.env.ASSISTANT_PROACTIVE_PUSH_INTERVAL_MINUTES || 0);
	if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) {
		return null;
	}

	const intervalMs = intervalMinutes * 60 * 1000;
	const timer = setInterval(() => {
		evaluateAndSendProactiveCommutePushes()
			.then((result) => {
				if (!result?.skipped) {
					console.log("[assistant proactive push]", result);
				}
			})
			.catch((error) => {
				console.error("[assistant proactive push]", error.message);
			});
	}, intervalMs);

	timer.unref?.();
	console.log(`[assistant proactive push] loop enabled every ${intervalMinutes} min`);
	return timer;
}

module.exports = {
	evaluateAndSendProactiveCommutePushes,
	startAssistantProactivePushLoop,
};
