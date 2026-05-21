// Shared push-gating helpers so every push type honours the same user
// preferences. Mirrors the quiet-hours logic preTripPushService already uses,
// extracted here so perturbation / incident / digest / assistant pushes all
// respect the silent window instead of only the pre-trip brief.

function isInQuietHours(user, now = new Date()) {
	if (!user) return false;
	if (user.quietHoursEnabled === false) return false;
	const start = Number.isInteger(user.quietHoursStartHour) ? user.quietHoursStartHour : 22;
	const end = Number.isInteger(user.quietHoursEndHour) ? user.quietHoursEndHour : 7;
	const hour = now.getHours();
	if (start === end) return false;
	if (start < end) return hour >= start && hour < end;
	// Wraps midnight: e.g. 22-7
	return hour >= start || hour < end;
}

module.exports = { isInQuietHours };
