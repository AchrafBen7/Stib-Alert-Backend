const OpenAI = require("openai");
const cache = require("./memoryCache");
const { SEVERITY } = require("./transportSeverity");

const AI_CACHE_TTL_MS = 3 * 60 * 1000;
const WARMED_KEYS = new Set();

let openaiClient = null;

function getOpenAIClient() {
	if (!process.env.OPENAI_API_KEY) return null;
	if (!openaiClient) {
		openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
	}
	return openaiClient;
}

function normalizeLine(line) {
	return String(line || "").trim();
}

function compactLineLabel(raw) {
	const line = normalizeLine(raw);
	if (!line) return null;
	return line.split(":")[0];
}

function compactStopName(raw) {
	return String(raw || "")
		.replace(/\s+/g, " ")
		.trim();
}

function uniqueStrings(values = []) {
	return [...new Set(values.filter(Boolean))];
}

function topEntriesByCount(items = [], limit = 3) {
	return Object.entries(
		items.reduce((accumulator, item) => {
			accumulator[item] = (accumulator[item] || 0) + 1;
			return accumulator;
		}, {})
	)
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "fr"))
		.slice(0, limit)
		.map(([value, count]) => ({ value, count }));
}

function sourceBucket(rawSource) {
	const source = String(rawSource || "").toLowerCase();
	if (!source) return "unknown";
	if (source.includes("official") || source.includes("stib")) return "official";
	if (source.includes("community")) return "community";
	return "mixed";
}

function sourceSummaryLabel(counts) {
	const official = counts.official || 0;
	const community = counts.community || 0;

	if (official > 0 && community > 0) return "mixte";
	if (official > 0) return "officiel";
	if (community > 0) return "communauté";
	return "mixte";
}

function localizedIncidentType(type) {
	const normalized = String(type || "").trim();
	if (!normalized) return null;
	return normalized;
}

function severityLead(severity) {
	switch (severity) {
	case SEVERITY.CRITICAL:
		return "Perturbations fortes";
	case SEVERITY.MAJOR:
		return "Réseau perturbé";
	case SEVERITY.MINOR:
		return "Réseau sous surveillance";
	default:
		return "Réseau fluide";
	}
}

function severityHint(severity) {
	switch (severity) {
	case SEVERITY.CRITICAL:
		return "Des coupures ou blocages probables demandent une alternative immédiate.";
	case SEVERITY.MAJOR:
		return "Des retards ou incidents significatifs restent actifs.";
	case SEVERITY.MINOR:
		return "Quelques signaux faibles restent actifs, sans blocage généralisé.";
	default:
		return "Aucune perturbation majeure n'est détectée pour le moment.";
	}
}

function buildSummaryKey(input) {
	return `perturbation-summary:${JSON.stringify({
		severity: input.severity,
		officialDataStatus: input.officialDataStatus,
		lines: input.affectedLines,
		stops: input.affectedStops,
		bullets: input.bullets,
		crowdingLevel: input.crowdingRisk?.level || null,
		crowdingZone: input.crowdingRisk?.zoneLabel || null,
	})}`;
}

async function generateAIPhrase(summary) {
	const client = getOpenAIClient();
	if (!client) return null;

	const prompt = [
		"Tu résumes des perturbations STIB pour une app mobile bruxelloise.",
		"Réécris en français très clair, en 1 phrase maximum, ton direct, sans inventer.",
		"Évite les emojis et les promesses. Reste concret.",
		`Titre: ${summary.title}`,
		`Résumé court: ${summary.shortText}`,
		`Lignes touchées: ${summary.affectedLines.join(", ") || "aucune"}`,
		`Zones touchées: ${summary.affectedStops.join(", ") || "aucune"}`,
		`Points clés: ${summary.bullets.join(" | ") || "aucun"}`,
		`Affluence événementielle: ${summary.crowdingRisk?.longText || "aucune"}`,
	].join("\n");

	const response = await client.chat.completions.create({
		model: "gpt-4o-mini",
		messages: [{ role: "user", content: prompt }],
		temperature: 0.2,
		max_tokens: 70,
	});

	return response.choices?.[0]?.message?.content?.trim() || null;
}

function warmNarrative(summary) {
	const client = getOpenAIClient();
	if (!client) return;

	const cacheKey = buildSummaryKey(summary);
	if (cache.get(cacheKey) || WARMED_KEYS.has(cacheKey)) return;

	WARMED_KEYS.add(cacheKey);
	cache
		.remember(cacheKey, AI_CACHE_TTL_MS, async () => generateAIPhrase(summary))
		.catch((error) => {
			console.warn("[perturbation-summary] AI warmup skipped:", error.message);
		})
		.finally(() => {
			WARMED_KEYS.delete(cacheKey);
		});
}

function buildPerturbationSummary({
	severity = SEVERITY.NORMAL,
	incidents = [],
	departures = [],
	officialDataStatus = "available",
	officialDataMessage = null,
	crowdingRisk = null,
} = {}) {
	const affectedLines = topEntriesByCount(
		uniqueStrings(
			incidents
				.map((incident) => compactLineLabel(incident.line))
		),
		3
	).map((entry) => entry.value);

	const affectedStops = topEntriesByCount(
		uniqueStrings(
			incidents
				.map((incident) => compactStopName(incident.stop?.name))
		),
		3
	).map((entry) => entry.value);

	const departureHighlights = departures
		.slice(0, 2)
		.map((departure) => `${compactLineLabel(departure.line)} dans ${departure.minutes} min`)
		.filter(Boolean);
	const typeHighlights = topEntriesByCount(
		uniqueStrings(
			incidents.map((incident) => localizedIncidentType(incident.type))
		),
		3
	).map((entry) => entry.value);
	const sourceBreakdown = incidents.reduce((accumulator, incident) => {
		const key = sourceBucket(incident.source);
		accumulator[key] = (accumulator[key] || 0) + 1;
		return accumulator;
	}, { official: 0, community: 0, mixed: 0 });

	const title = severityLead(severity);
	const bullets = [];

	if (affectedLines.length) {
		bullets.push(
			affectedLines.length === 1
				? `La ligne ${affectedLines[0]} concentre l'essentiel du risque.`
				: `Les lignes ${affectedLines.join(", ")} concentrent l'essentiel du risque.`
		);
	}

	if (affectedStops.length) {
		bullets.push(
			affectedStops.length === 1
				? `Point sensible principal: ${affectedStops[0]}.`
				: `Zones les plus touchées: ${affectedStops.join(", ")}.`
		);
	}

	if (departureHighlights.length) {
		bullets.push(`Prochains passages encore lisibles: ${departureHighlights.join(" • ")}.`);
	}

	if (typeHighlights.length) {
		bullets.push(
			typeHighlights.length === 1
				? `Incident dominant: ${typeHighlights[0]}.`
				: `Incidents dominants: ${typeHighlights.join(", ")}.`
		);
	}

	if (!bullets.length) {
		bullets.push(severityHint(severity));
	}

	if (crowdingRisk?.level && crowdingRisk.level !== "none") {
		bullets.push(crowdingRisk.longText);
	}

	if (officialDataStatus === "limited" && officialDataMessage) {
		bullets.push("Les données officielles sont partielles, lecture basée sur le dernier état connu.");
	}

	if (officialDataStatus === "unavailable" && officialDataMessage) {
		bullets.push("Les données officielles sont indisponibles, lecture basée sur les retours terrain.");
	}

	let shortText = severityHint(severity);
	if (affectedLines.length && affectedStops.length) {
		shortText = `${title} sur ${affectedLines.join(", ")} autour de ${affectedStops[0]}.`;
	} else if (affectedLines.length) {
		shortText = `${title} sur ${affectedLines.join(", ")}.`;
	} else if (affectedStops.length) {
		shortText = `${title} autour de ${affectedStops[0]}.`;
	} else if (departureHighlights.length) {
		shortText = `${title}. Prochains passages encore lisibles: ${departureHighlights.join(" • ")}.`;
	}

	const longText = [shortText, ...bullets.slice(0, 2).filter((bullet) => !shortText.includes(bullet))]
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();

	const summary = {
		title,
		shortText,
		longText,
		bullets: bullets.slice(0, 3),
		affectedLines,
		affectedStops,
		incidentTypes: typeHighlights,
		sourceLabel: sourceSummaryLabel(sourceBreakdown),
		sourceBreakdown,
		crowdingRisk,
		source: "rules",
	};

	const cacheKey = buildSummaryKey(summary);
	const cachedNarrative = cache.get(cacheKey)?.value;
	if (cachedNarrative) {
		return {
			...summary,
			longText: cachedNarrative,
			source: "rules+ai",
		};
	}

	warmNarrative(summary);
	return summary;
}

module.exports = {
	buildPerturbationSummary,
};
