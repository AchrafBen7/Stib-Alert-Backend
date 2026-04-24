const fetch = require("node-fetch");

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const RESEND_TIMEOUT_MS = 8000;

async function sendMail(to, subject, html, text = null) {
	const apiKey = process.env.RESEND_API_KEY;
	const from = process.env.RESEND_FROM_EMAIL;

	if (!apiKey) {
		throw new Error("RESEND_API_KEY manquant");
	}

	if (!from) {
		throw new Error("RESEND_FROM_EMAIL manquant");
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), RESEND_TIMEOUT_MS);

	try {
		const response = await fetch(RESEND_ENDPOINT, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				from,
				to: Array.isArray(to) ? to : [to],
				subject,
				html,
				text: text || undefined,
			}),
			signal: controller.signal,
		});

		const payload = await response.json().catch(() => ({}));
		if (!response.ok) {
			throw new Error(payload?.message || payload?.error || `Resend HTTP ${response.status}`);
		}

		return payload;
	} catch (error) {
		if (error.name === "AbortError") {
			throw new Error(`Resend timeout after ${RESEND_TIMEOUT_MS}ms`);
		}
		throw error;
	} finally {
		clearTimeout(timer);
	}
}

module.exports = sendMail;
