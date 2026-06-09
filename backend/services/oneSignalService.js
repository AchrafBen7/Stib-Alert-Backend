const fetch = require("node-fetch");

// .trim() : une variable d'env copiée-collée sur Render traîne souvent un
// espace / retour de ligne invisible qui faisait échouer l'auth OneSignal.
const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID?.trim();
const ONESIGNAL_REST_API_KEY = process.env.ONESIGNAL_REST_API_KEY?.trim();
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
	const payload = JSON.stringify({ app_id: ONESIGNAL_APP_ID, ...body });

	// OneSignal a DEUX générations de clés REST avec des schémas d'en-tête
	// différents : les nouvelles (`os_v2_…`) → `Key`, les anciennes → `Basic`.
	// Envoyer le mauvais schéma renvoie "Access denied". On détecte le format,
	// et on RETENTE avec l'autre schéma si l'auth échoue (401/403) → robuste
	// quelle que soit la clé configurée sur Render.
	const detectedScheme = ONESIGNAL_REST_API_KEY.startsWith("os_v2_") ? "Key" : "Basic";
	const fallbackScheme = detectedScheme === "Key" ? "Basic" : "Key";

	const attempt = (scheme) =>
		fetch(`https://onesignal.com/api/v1${path}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `${scheme} ${ONESIGNAL_REST_API_KEY}`,
			},
			body: payload,
		});

	let response = await attempt(detectedScheme);
	if (response.status === 401 || response.status === 403) {
		// Mauvais schéma deviné → on tente l'autre avant d'abandonner.
		response = await attempt(fallbackScheme);
	}

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
