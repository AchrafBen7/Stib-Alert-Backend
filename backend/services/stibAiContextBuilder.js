function compactText(value, max = 240) {
	if (value == null) return "";
	const text = String(value).replace(/\s+/g, " ").trim();
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function list(values, fallback = "—") {
	if (!Array.isArray(values) || values.length === 0) return fallback;
	return values.filter(Boolean).join(", ") || fallback;
}

function buildRouteSummary(route, index) {
	const total = route.totalMin ?? route.totalDurationMinutes ?? route.durationMinutes;
	const transfers = route.transfers ?? 0;
	const lines = Array.isArray(route.lines)
		? route.lines
		: Array.isArray(route.steps)
			? route.steps.map((step) => step.line).filter(Boolean)
			: [];
	const header = `Option ${index + 1}${total ? ` — ${total} min` : ""}${transfers ? `, ${transfers} correspondance(s)` : ""}`;
	const steps = Array.isArray(route.steps)
		? route.steps.slice(0, 8).map((step) => {
			const line = step.line ? `**${step.line}** ` : "";
			const from = step.fromName || step.stopName || step.instruction || "?";
			const to = step.toName || step.arrivalStopName || step.destination || "?";
			const mins = step.minutes ?? step.durationMinutes;
			const disrupted = step.disrupted || (Array.isArray(step.alerts) && step.alerts.length) ? " ⚠️" : "";
			return `  - ${line}${from} → ${to}${mins ? ` (${mins} min)` : ""}${disrupted}`;
		})
		: [];
	return [
		`- ${header}`,
		lines.length ? `  - Lignes: ${list([...new Set(lines)])}` : null,
		route.fromStop || route.toStop ? `  - De ${route.fromStop || "?"} à ${route.toStop || "?"}` : null,
		...steps,
	].filter(Boolean).join("\n");
}

function buildContextMessage(ctx = {}) {
	const parts = ["## CONTEXTE LIVE — mobilité Bruxelles"];

	if (ctx.network) {
		parts.push([
			"### État global",
			`- Niveau: ${ctx.network.level || "inconnu"}`,
			`- Résumé: ${compactText(ctx.network.headline || ctx.network.summary || "Aucun résumé.")}`,
			`- Lignes touchées: ${list(ctx.network.affectedLines)}`,
		].join("\n"));
	}

	if (Array.isArray(ctx.disruptedLines) && ctx.disruptedLines.length) {
		parts.push(`### Lignes perturbées\n${ctx.disruptedLines.slice(0, 30).map((line) => `- **${line}**`).join("\n")}`);
	}

	if (Array.isArray(ctx.travellersInfo) && ctx.travellersInfo.length) {
		const rows = ctx.travellersInfo.slice(0, 10).map((info) => {
			const linePart = Array.isArray(info.lines) && info.lines.length ? ` — lignes: ${list(info.lines)}` : "";
			const stopPart = Array.isArray(info.points) && info.points.length ? ` — arrêts/points: ${list(info.points.slice(0, 6))}` : "";
			return `- [${info.type || "info"}${info.priority ? ` p${info.priority}` : ""}] ${compactText(info.title || info.description || "Information officielle")}${linePart}${stopPart}`;
		});
		parts.push(`### Informations officielles opérateurs\n${rows.join("\n")}`);
	}

	if (Array.isArray(ctx.reports) && ctx.reports.length) {
		const rows = ctx.reports.slice(0, 12).map((report) => {
			const line = report.line ? ` **${report.line}**` : "";
			const stop = report.stop ? ` @ ${report.stop}` : "";
			const age = report.ageMin != null ? ` (${report.ageMin} min)` : "";
			return `- ${report.type || "signalement"}${line}${stop}${age}`;
		});
		parts.push(`### Signalements communautaires récents\n${rows.join("\n")}`);
	}

	if (ctx.activeTrip) {
		parts.push([
			"### Trajet actif",
			`- De: ${ctx.activeTrip.fromName || "?"} → ${ctx.activeTrip.toName || "?"}`,
			`- Lignes: ${list(ctx.activeTrip.lines)}`,
			`- Arrêts: ${list(ctx.activeTrip.stopIds)}`,
		].join("\n"));
	}

	if (ctx.position) {
		parts.push(`### Position utilisateur\n- Lat/Lng: ${ctx.position.lat}, ${ctx.position.lng}`);
	} else {
		parts.push("### Position utilisateur\n- Absente. Ne devine pas la position.");
	}

	if (ctx.currentStartStop) {
		parts.push([
			"### Arrêt de départ courant",
			`- ${ctx.currentStartStop.name || "?"}${ctx.currentStartStop.distance != null ? ` (${Math.round(ctx.currentStartStop.distance)} m)` : ""}`,
			`- Lignes disponibles: ${list(ctx.currentStartStop.lines)}`,
			ctx.currentStartStop.mode ? `- Mode: ${ctx.currentStartStop.mode}` : null,
		].filter(Boolean).join("\n"));
	}

	if (Array.isArray(ctx.nearbyStops) && ctx.nearbyStops.length) {
		const rows = ctx.nearbyStops.slice(0, 8).map((stop) => {
			const distance = stop.distance != null ? ` — ${Math.round(stop.distance)} m` : "";
			return `- ${stop.name}${distance} — lignes: ${list(stop.lines)}`;
		});
		parts.push(`### Arrêts / gares proches\n${rows.join("\n")}`);
	}

	if (Array.isArray(ctx.followedLines) && ctx.followedLines.length) {
		parts.push(`### Lignes favorites\n${list(ctx.followedLines)}`);
	}

	if (ctx.proposedDestination) {
		parts.push(`### Destination demandée\n- ${compactText(ctx.proposedDestination, 120)}`);
	}

	if (Array.isArray(ctx.proposedRoutes) && ctx.proposedRoutes.length) {
		parts.push(`### 🎯 TRAJET CALCULÉ — SOURCE DE VÉRITÉ\n${ctx.proposedRoutes.slice(0, 3).map(buildRouteSummary).join("\n")}`);
	} else if (ctx.proposedDestination) {
		parts.push("### TRAJET CALCULÉ\n- Aucun trajet calculé disponible. Ne donne pas de lignes précises inventées.");
	}

	return parts.join("\n\n");
}

module.exports = {
	buildContextMessage,
};
