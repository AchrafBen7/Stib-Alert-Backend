const fetch = require("node-fetch");

const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID;
const ONESIGNAL_REST_API_KEY = process.env.ONESIGNAL_REST_API_KEY;
const IS_ONESIGNAL_CONFIGURED = Boolean(ONESIGNAL_APP_ID && ONESIGNAL_REST_API_KEY);
let hasLoggedMissingConfig = false;

function warnIfMissingConfig() {
	if (!IS_ONESIGNAL_CONFIGURED && !hasLoggedMissingConfig) {
		hasLoggedMissingConfig = true;
		console.warn("[ONESIGNAL] ONESIGNAL_APP_ID / ONESIGNAL_REST_API_KEY manquants. Les push Stibi sont désactivées.");
	}
}

function ensureConfigured() {
	if (!IS_ONESIGNAL_CONFIGURED) {
		throw new Error("OneSignal is not configured");
	}
}

function getDeviceType(platform) {
	if (platform === "android") return 1;
	return 0;
}

async function oneSignalRequest(path, body) {
	ensureConfigured();
	const response = await fetch(`https://onesignal.com/api/v1${path}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Basic ${ONESIGNAL_REST_API_KEY}`,
		},
		body: JSON.stringify({
			app_id: ONESIGNAL_APP_ID,
			...body,
		}),
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`OneSignal request failed: ${text}`);
	}

	return response.json();
}

async function registerDevice({ userId, token, platform = "ios" }) {
	if (!IS_ONESIGNAL_CONFIGURED) {
		warnIfMissingConfig();
		return { success: false, reason: "OneSignal not configured" };
	}

	return oneSignalRequest("/players", {
		identifier: token,
		device_type: getDeviceType(platform),
		external_user_id: userId,
	});
}

async function sendNotificationToUser({ userId, title, message, titles, messages, data, url }) {
	if (!IS_ONESIGNAL_CONFIGURED) {
		warnIfMissingConfig();
		return { success: false, reason: "OneSignal not configured" };
	}

	return oneSignalRequest("/notifications", {
		include_external_user_ids: [userId],
		headings: titles || { fr: title, nl: title, en: title },
		contents: messages || { fr: message, nl: message, en: message },
		data: data || undefined,
		url: url || undefined,
	});
}

async function sendNotificationWithDeepLink({ userId, title, message, titles, messages, type, id, deepLink }) {
	const finalDeepLink = deepLink || `stibalert://stibi/${type}${id ? `/${id}` : ""}`;
	return sendNotificationToUser({
		userId,
		title,
		message,
		titles,
		messages,
		url: finalDeepLink,
		data: {
			type,
			id: id || null,
			deep_link: finalDeepLink,
		},
	});
}

warnIfMissingConfig();

module.exports = {
	registerDevice,
	sendNotificationToUser,
	sendNotificationWithDeepLink,
};
