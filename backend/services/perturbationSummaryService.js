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

const LEAD = {
	fr: { critical: "Perturbations fortes", major: "Réseau perturbé", minor: "Réseau sous surveillance", normal: "Réseau fluide" },
	nl: { critical: "Sterke verstoringen", major: "Netwerk verstoord", minor: "Netwerk onder toezicht", normal: "Vlot netwerk" },
};
const HINT = {
	fr: {
		critical: "Des coupures ou blocages probables demandent une alternative immédiate.",
		major: "Des retards ou incidents significatifs restent actifs.",
		minor: "Quelques signaux faibles restent actifs, sans blocage généralisé.",
		normal: "Aucune perturbation majeure n'est détectée pour le moment.",
	},
	nl: {
		critical: "Onderbrekingen of blokkades zijn waarschijnlijk — neem meteen een alternatief.",
		major: "Aanzienlijke vertragingen of incidenten blijven actief.",
		minor: "Enkele zwakke signalen blijven actief, zonder algemene blokkade.",
		normal: "Voorlopig geen grote verstoring gedetecteerd.",
	},
};

function sevKey(severity) {
	switch (severity) {
	case SEVERITY.CRITICAL: return "critical";
	case SEVERITY.MAJOR: return "major";
	case SEVERITY.MINOR: return "minor";
	default: return "normal";
	}
}

function severityLead(severity, lang = "fr") {
	return (LEAD[lang] || LEAD.fr)[sevKey(severity)];
}

function severityHint(severity, lang = "fr") {
	return (HINT[lang] || HINT.fr)[sevKey(severity)];
}

/// Compose titre + shortText + longText + bullets dans la langue demandée à
/// partir des données déjà extraites. FR par défaut ; NL pour l'app néerlandaise.
function composeNarrative(lang, { severity, affectedLines, affectedStops, departures, typeHighlights, officialDataStatus, officialDataMessage, crowdingRisk }) {
	const fr = lang !== "nl";
	const title = severityLead(severity, lang);
	const departureHighlights = departures
		.slice(0, 2)
		.map((d) => fr ? `${compactLineLabel(d.line)} dans ${d.minutes} min` : `${compactLineLabel(d.line)} over ${d.minutes} min`)
		.filter(Boolean);

	const bullets = [];
	if (affectedLines.length) {
		if (fr) bullets.push(affectedLines.length === 1 ? `La ligne ${affectedLines[0]} concentre l'essentiel du risque.` : `Les lignes ${affectedLines.join(", ")} concentrent l'essentiel du risque.`);
		else bullets.push(affectedLines.length === 1 ? `Lijn ${affectedLines[0]} draagt het grootste risico.` : `Lijnen ${affectedLines.join(", ")} dragen het grootste risico.`);
	}
	if (affectedStops.length) {
		if (fr) bullets.push(affectedStops.length === 1 ? `Point sensible principal: ${affectedStops[0]}.` : `Zones les plus touchées: ${affectedStops.join(", ")}.`);
		else bullets.push(affectedStops.length === 1 ? `Belangrijkste knelpunt: ${affectedStops[0]}.` : `Meest getroffen zones: ${affectedStops.join(", ")}.`);
	}
	if (departureHighlights.length) {
		bullets.push(fr ? `Prochains passages encore lisibles: ${departureHighlights.join(" • ")}.` : `Volgende doorkomsten nog leesbaar: ${departureHighlights.join(" • ")}.`);
	}
	if (typeHighlights.length) {
		if (fr) bullets.push(typeHighlights.length === 1 ? `Incident dominant: ${typeHighlights[0]}.` : `Incidents dominants: ${typeHighlights.join(", ")}.`);
		else bullets.push(typeHighlights.length === 1 ? `Belangrijkste incident: ${typeHighlights[0]}.` : `Belangrijkste incidenten: ${typeHighlights.join(", ")}.`);
	}
	if (!bullets.length) bullets.push(severityHint(severity, lang));
	if (crowdingRisk?.level && crowdingRisk.level !== "none") bullets.push(crowdingRisk.longText);
	if (officialDataStatus === "limited" && officialDataMessage) {
		bullets.push(fr ? "Les données officielles sont partielles, lecture basée sur le dernier état connu." : "De officiële gegevens zijn onvolledig; lezing op basis van de laatst bekende status.");
	}
	if (officialDataStatus === "unavailable" && officialDataMessage) {
		bullets.push(fr ? "Les données officielles sont indisponibles, lecture basée sur les retours terrain." : "De officiële gegevens zijn niet beschikbaar; lezing op basis van meldingen op het terrein.");
	}

	let shortText = severityHint(severity, lang);
	if (affectedLines.length && affectedStops.length) shortText = fr ? `${title} sur ${affectedLines.join(", ")} autour de ${affectedStops[0]}.` : `${title} op ${affectedLines.join(", ")} rond ${affectedStops[0]}.`;
	else if (affectedLines.length) shortText = fr ? `${title} sur ${affectedLines.join(", ")}.` : `${title} op ${affectedLines.join(", ")}.`;
	else if (affectedStops.length) shortText = fr ? `${title} autour de ${affectedStops[0]}.` : `${title} rond ${affectedStops[0]}.`;
	else if (departureHighlights.length) shortText = fr ? `${title}. Prochains passages encore lisibles: ${departureHighlights.join(" • ")}.` : `${title}. Volgende doorkomsten nog leesbaar: ${departureHighlights.join(" • ")}.`;

	const longText = [shortText, ...bullets.slice(0, 2).filter((bullet) => !shortText.includes(bullet))]
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
	return { title, shortText, longText, bullets: bullets.slice(0, 3) };
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

	// On compose le texte en FR (par défaut, enrichi par l'IA) ET en NL, pour
	// que l'app néerlandaise n'affiche plus du français dans la carte « avis
	// réseau ». Même règles, mêmes données — seuls les libellés changent.
	const narrativeData = { severity, affectedLines, affectedStops, departures, typeHighlights, officialDataStatus, officialDataMessage, crowdingRisk };
	const fr = composeNarrative("fr", narrativeData);
	const nl = composeNarrative("nl", narrativeData);

	const summary = {
		title: fr.title,
		shortText: fr.shortText,
		longText: fr.longText,
		bullets: fr.bullets,
		titleNl: nl.title,
		shortTextNl: nl.shortText,
		longTextNl: nl.longText,
		bulletsNl: nl.bullets,
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
