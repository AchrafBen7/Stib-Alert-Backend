const SEVERITY = {
	NORMAL: "normal",
	MINOR: "minor",
	MAJOR: "major",
	CRITICAL: "critical",
};

const severityRank = {
	[SEVERITY.NORMAL]: 0,
	[SEVERITY.MINOR]: 1,
	[SEVERITY.MAJOR]: 2,
	[SEVERITY.CRITICAL]: 3,
};

const localizedSeverity = {
	normal: { fr: "Normal", nl: "Normaal", en: "Normal", color: "#49D7A5", realtimeStatus: "stable" },
	minor: { fr: "Mineur", nl: "Licht", en: "Minor", color: "#FFBF66", realtimeStatus: "watch" },
	major: { fr: "Perturbé", nl: "Verstoord", en: "Major", color: "#FF922A", realtimeStatus: "disrupted" },
	critical: { fr: "Bloqué", nl: "Geblokkeerd", en: "Critical", color: "#FF7178", realtimeStatus: "blocked" },
};

function clampConfidence(value) {
	if (typeof value !== "number" || Number.isNaN(value)) return 0.5;
	return Math.min(Math.max(value, 0), 1);
}

function maxSeverity(current, next) {
	return severityRank[next] > severityRank[current] ? next : current;
}

function confidenceFromLegacy(value) {
	switch (String(value || "").toLowerCase()) {
	case "haute":
	case "high":
		return 0.9;
	case "moyenne":
	case "medium":
		return 0.7;
	case "basse":
	case "low":
		return 0.45;
	default:
		return 0.55;
	}
}

function severityFromSignalement(signalement) {
	const type = String(signalement?.typeProbleme || "").toLowerCase();
	const confidence = confidenceFromLegacy(signalement?.confiance);

	let severity = SEVERITY.MINOR;

	if (["accident", "agression"].includes(type)) severity = SEVERITY.CRITICAL;
	else if (["panne"].includes(type)) severity = SEVERITY.MAJOR;
	else if (["retard", "incivilité", "incivilite"].includes(type)) severity = SEVERITY.MAJOR;
	// Contrôle / Affluence : infos utiles mais non bloquantes → MINOR (défaut).
	else if (["contrôle", "controle", "affluence", "propreté", "proprete", "autre"].includes(type)) severity = SEVERITY.MINOR;

	if (confidence < 0.5 && severityRank[severity] > severityRank[SEVERITY.MINOR]) {
		severity = severity === SEVERITY.CRITICAL ? SEVERITY.MAJOR : SEVERITY.MINOR;
	}

	return severity;
}

function severityFromLegacyStatus(value) {
	const normalized = String(value || "").toLowerCase();
	if (["bloqué", "bloque", "critical", "rouge", "blocked"].includes(normalized)) return SEVERITY.CRITICAL;
	if (["perturbé", "perturbe", "orange", "major", "disrupted"].includes(normalized)) return SEVERITY.MAJOR;
	if (["mineur", "minor", "watch"].includes(normalized)) return SEVERITY.MINOR;
	return SEVERITY.NORMAL;
}

function summarizeSeverity(items = []) {
	if (!items.length) {
		return formatSeverity(SEVERITY.NORMAL, 0.9);
	}

	let severity = SEVERITY.NORMAL;
	let confidence = 0.5;

	for (const item of items) {
		const nextSeverity = item.severity || severityFromSignalement(item);
		severity = maxSeverity(severity, nextSeverity);
		confidence = Math.max(confidence, item.confidence ?? confidenceFromLegacy(item.confiance));
	}

	return formatSeverity(severity, confidence);
}

function severityFromStatus(status) {
	return severityFromLegacyStatus(status);
}

function formatSeverity(severity, confidence = 0.5) {
	const normalized = localizedSeverity[severity] ? severity : SEVERITY.NORMAL;
	const meta = localizedSeverity[normalized];
	return {
		severity: normalized,
		confidence: clampConfidence(confidence),
		realtimeStatus: meta.realtimeStatus,
		label: {
			fr: meta.fr,
			nl: meta.nl,
			en: meta.en,
		},
		color: meta.color,
	};
}

module.exports = {
	SEVERITY,
	confidenceFromLegacy,
	formatSeverity,
	severityFromLegacyStatus,
	severityFromStatus,
	severityFromSignalement,
	summarizeSeverity,
	maxSeverity,
};
