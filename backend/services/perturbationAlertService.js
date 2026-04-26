const Utilisateur = require("../models/Utilisateur");
const AssistantNotificationLog = require("../models/AssistantNotificationLog");
const { sendNotificationWithDeepLink } = require("./oneSignalService");

// ─── Brussels corridors ───────────────────────────────────────────────────────
// Key  = affected line
// Value = ordered fallback alternatives (first = best)
// Source: STIB network geography, updated manually as needed
const CORRIDOR_ALTERNATIVES = {
	"1":  ["5"],
	"2":  ["6"],
	"3":  ["4", "1"],
	"4":  ["3", "2"],
	"5":  ["1"],
	"6":  ["2"],
	"7":  ["8", "9"],
	"8":  ["7", "9"],
	"9":  ["10", "25"],
	"10": ["9", "25"],
	"12": [],
	"19": ["25", "10"],
	"25": ["19", "10"],
	"38": ["95", "25"],
	"46": ["38"],
	"71": ["81", "92"],
	"81": ["71", "92"],
	"92": ["81", "71"],
	"95": ["38", "92"],
};

const PROBLEM_LABEL = {
	Retard:   "Retard signalé",
	Accident: "Accident signalé",
	Panne:    "Panne signalée",
	Autre:    "Perturbation signalée",
};

// 4-hour cooldown: don't push the same perturbation (by externalId/signalementId) twice to the same user
const ALERT_COOLDOWN_MS = 4 * 60 * 60 * 1000;

// Only send between 06:00 and 22:00 Brussels local time
function isInBrusselsAlertWindow() {
	const hour = Number(
		new Intl.DateTimeFormat("fr-BE", {
			timeZone: "Europe/Brussels",
			hour:     "numeric",
			hour12:   false,
		}).format(new Date())
	);
	return hour >= 6 && hour < 22;
}

function buildPushContent(ligne, typeProbleme) {
	const alts = CORRIDOR_ALTERNATIVES[ligne] || [];
	const label = PROBLEM_LABEL[typeProbleme] || "Perturbation signalée";
	const altText = alts.length
		? ` Essaie la ligne ${alts[0]}${alts[1] ? ` ou ${alts[1]}` : ""}.`
		: " Vérifie les alternatives.";

	return {
		title:   `⚠️ Ligne ${ligne}`,
		message: `${label} sur ta ligne.${altText}`,
	};
}

// ─── Main export ──────────────────────────────────────────────────────────────
// Called by stibOfficialSeedService with the list of newly inserted signalements.
async function sendAlertsForNewPerturbations(newSignalements) {
	if (!newSignalements || newSignalements.length === 0) {
		return { sent: 0, skipped: 0 };
	}
	if (!isInBrusselsAlertWindow()) {
		return { sent: 0, skipped: 0, reason: "outside_alert_window" };
	}

	let sent = 0;
	let skipped = 0;

	for (const sig of newSignalements) {
		const ligne = sig.ligne;

		// Skip generic STIB-level signalements with no useful line
		if (!ligne || ligne === "STIB" || ligne.length > 4) continue;

		// Unique key for deduplication — per external perturbation
		const contextKey = `perturbation_alert:${sig.externalId || sig._id || ligne}`;

		// Find users who follow this line and have push enabled
		let users;
		try {
			users = await Utilisateur.find({
				notifications:      true,
				oneSignalPlayerId:  { $exists: true, $ne: null },
				favoriteLines:      ligne,
			})
				.select("_id oneSignalPlayerId")
				.lean();
		} catch (err) {
			console.warn(`[perturbation-alert] user query failed for ligne ${ligne}: ${err.message}`);
			continue;
		}

		if (users.length === 0) continue;

		const { title, message } = buildPushContent(ligne, sig.typeProbleme);

		for (const user of users) {
			// Deduplication check
			try {
				const recent = await AssistantNotificationLog.findOne({
					userId:     user._id,
					contextKey,
					type:       "perturbation_alert",
					sentAt:     { $gte: new Date(Date.now() - ALERT_COOLDOWN_MS) },
				}).lean();

				if (recent) { skipped++; continue; }
			} catch (_) {
				// Don't block push on a log read failure
			}

			// Send push
			try {
				await sendNotificationWithDeepLink({
					userId:   String(user._id),
					title,
					message,
					type:     "perturbation_alert",
					id:       ligne,
					deepLink: "stibalert://signalements",
				});

				// Log send for deduplication
				await AssistantNotificationLog.create({
					userId:     user._id,
					type:       "perturbation_alert",
					contextKey,
					priority:   "high",
					title,
					message,
					sentAt:     new Date(),
				});

				sent++;
			} catch (err) {
				console.warn(`[perturbation-alert] push failed user=${user._id} ligne=${ligne}: ${err.message}`);
				skipped++;
			}
		}
	}

	return { sent, skipped };
}

module.exports = { sendAlertsForNewPerturbations };
