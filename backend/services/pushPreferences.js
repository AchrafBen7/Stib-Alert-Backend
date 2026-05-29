// Shared push-gating helpers so every push type honours the same user
// preferences. Mirrors the quiet-hours logic preTripPushService already uses,
// extracted here so perturbation / incident / digest / assistant pushes all
// respect the silent window instead of only the pre-trip brief.

// B1 — Heure de référence en Europe/Brussels, PAS l'heure locale du serveur.
// Render tourne en UTC : un silence "22h-7h" s'appliquait en réalité 1-2h
// trop tard côté belge (selon l'heure d'été). On lit l'heure de Bruxelles
// explicitement, comme isInBrusselsAlertWindow.
function brusselsHour(now = new Date()) {
	return Number(
		new Intl.DateTimeFormat("fr-BE", {
			timeZone: "Europe/Brussels",
			hour: "numeric",
			hour12: false,
		}).format(now)
	);
}

function isInQuietHours(user, now = new Date()) {
	if (!user) return false;
	if (user.quietHoursEnabled === false) return false;
	const start = Number.isInteger(user.quietHoursStartHour) ? user.quietHoursStartHour : 22;
	const end = Number.isInteger(user.quietHoursEndHour) ? user.quietHoursEndHour : 7;
	const hour = brusselsHour(now);
	if (start === end) return false;
	if (start < end) return hour >= start && hour < end;
	// Wraps midnight: e.g. 22-7
	return hour >= start || hour < end;
}

module.exports = { isInQuietHours, brusselsHour };
