const bcrypt = require("bcryptjs");
const Utilisateur = require("../models/Utilisateur");
const logger = require("./logger");

/**
 * Upserts a stable demo account from env vars on server startup. Used to
 * guarantee the Apple App Store reviewer can log in even if other accounts
 * have been deleted or their passwords drifted.
 *
 * Set these on Render before the next deploy, then unset/rotate after launch:
 *   DEMO_ACCOUNT_EMAIL=demo.review@stibalert.app
 *   DEMO_ACCOUNT_PASSWORD=DemoStib2026!
 *   DEMO_ACCOUNT_NAME=App Reviewer
 *
 * Idempotent — calling it on every boot either creates the user or rewrites
 * their password so we always know what it is.
 */
async function bootstrapDemoAccountIfRequested() {
	const email = process.env.DEMO_ACCOUNT_EMAIL?.trim().toLowerCase();
	const rawPassword = process.env.DEMO_ACCOUNT_PASSWORD;
	const name = process.env.DEMO_ACCOUNT_NAME?.trim() || "App Reviewer";

	if (!email || !rawPassword) {
		return { skipped: true, reason: "no env vars" };
	}

	if (rawPassword.length < 8) {
		logger.warn("[demo-account] DEMO_ACCOUNT_PASSWORD too short, skipping");
		return { skipped: true, reason: "password too short" };
	}

	try {
		const hashed = await bcrypt.hash(rawPassword, 12);
		const result = await Utilisateur.findOneAndUpdate(
			{ email },
			{
				$set: {
					nom: name,
					motDePasse: hashed,
					notifications: true,
					preTripPushEnabled: true,
					mercisPushEnabled: true,
					quietHoursEnabled: false,
					langue: "FR",
					role: "Utilisateur",
					favoriteLines: ["7", "56", "92"],
					routine: {
						enabled: true,
						homeLabel: "Domicile",
						workLabel: "Bureau",
						departureTime: "08:15",
					},
				},
			},
			{ upsert: true, new: true, setDefaultsOnInsert: true }
		);

		logger.info("[demo-account] upserted demo account", {
			email,
			id: String(result._id),
		});
		return { upserted: true, email };
	} catch (error) {
		logger.error("[demo-account] failed to upsert demo account", {
			error: error.message,
		});
		return { error: error.message };
	}
}

module.exports = { bootstrapDemoAccountIfRequested };
