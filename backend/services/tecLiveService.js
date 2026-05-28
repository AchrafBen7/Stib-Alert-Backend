// TEC déviations live — via GTFS-RT alerts du portail Belgian Mobility
// Company. Le portail retourne du JSON déjà décodé (PAS du protobuf binaire
// comme on pourrait croire), donc parsing trivial.
//
// Réutilise la clé BELGIAN_MOBILITY_API_KEY déjà en place pour STIB →
// ATTENTION : chaque appel mange le même quota Mobility partagé. Mitigation :
// 1 appel toutes les 3 min (cache TTL strict). Le payload contient TOUTES
// les alertes en une fois (1268+ en mai 2026), donc 1 appel suffit pour
// servir tous les utilisateurs.
//
// On NE fait PAS de trip-update / temps réel par arrêt (trop coûteux en
// quota + exige le parsing du GTFS static + croisement stop_times). Si
// besoin un jour : étendre ce service.

const logger = require("./logger");

const BASE_URL = "https://api-management-opendata-production.azure-api.net";
const ALERTS_PATH = "/api/gtfs/feed/tec/rt/alert";
const ALERTS_TTL_MS = 180_000; // 3 min — prudent (quota partagé STIB)
const REQUEST_TIMEOUT_MS = 10_000;
const USER_AGENT = "StibAlert/1.0 (TFE student project; +https://github.com/AchrafBen7/StibAlert)";

let alertsCache = { at: 0, data: null };

function apiKey() {
	return process.env.BELGIAN_MOBILITY_API_KEY || "";
}

function apiKeyHeader() {
	// BMC custom header. Honore l'override env si défini.
	return process.env.BELGIAN_MOBILITY_API_KEY_HEADER || "bmc-partner-key";
}

function isConfigured() {
	return Boolean(apiKey());
}

/** Récupère un translated_string GTFS-RT en français (sinon NL, sinon EN, sinon brut). */
function frenchOf(translatedString) {
	if (!translatedString || !Array.isArray(translatedString.translation)) return "";
	const tr = translatedString.translation;
	const fr = tr.find((t) => /^fr/i.test(t.language || ""));
	if (fr?.text) return fr.text;
	const nl = tr.find((t) => /^nl/i.test(t.language || ""));
	if (nl?.text) return nl.text;
	const en = tr.find((t) => /^en/i.test(t.language || ""));
	if (en?.text) return en.text;
	return tr[0]?.text || "";
}

function unixToIso(seconds) {
	if (!seconds) return null;
	// Garde-fou : timestamp GTFS-RT max raisonnable (~année 2200). Au-delà
	// c'est probablement un "end" sentinel (ex: 7258114800 = an 2200).
	const ms = Number(seconds) * 1000;
	if (ms > 7258118400000) return null;
	return new Date(ms).toISOString();
}

/** Map une entity GTFS-RT vers notre shape (alignée De Lijn → iOS code partagé). */
function mapAlert(entity) {
	const a = entity.alert || {};
	const period = (a.activePeriod && a.activePeriod[0]) || {};
	const affectedLines = [];
	const affectedStops = [];
	for (const inf of a.informedEntity || []) {
		if (inf.routeId) {
			affectedLines.push({
				entity: "tec",
				line: String(inf.routeId),
				direction: null,
				description: null,
			});
		}
		if (inf.stopId) {
			affectedStops.push({ entity: "tec", halte: String(inf.stopId) });
		}
	}
	return {
		id: String(entity.id || ""),
		title: frenchOf(a.headerText) || "Perturbation TEC",
		description: frenchOf(a.descriptionText) || "",
		startDate: unixToIso(period.start),
		endDate: unixToIso(period.end),
		affectedLines,
		affectedStops,
		url: frenchOf(a.url) || null,
	};
}

async function fetchAlerts() {
	if (typeof fetch !== "function") {
		throw new Error("global fetch unavailable (Node 18+ required)");
	}
	const key = apiKey();
	if (!key) throw new Error("BELGIAN_MOBILITY_API_KEY not configured");

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		const res = await fetch(`${BASE_URL}${ALERTS_PATH}`, {
			signal: controller.signal,
			headers: {
				[apiKeyHeader()]: key,
				"User-Agent": USER_AGENT,
				Accept: "application/json",
			},
		});
		if (!res.ok) {
			throw new Error(`TEC HTTP ${res.status}`);
		}
		const json = await res.json();
		return (json.entity || []).filter((e) => e.alert).map(mapAlert);
	} finally {
		clearTimeout(timer);
	}
}

async function getNetworkDisruptions() {
	if (alertsCache.data && Date.now() - alertsCache.at < ALERTS_TTL_MS) {
		return alertsCache.data;
	}
	try {
		const disruptions = await fetchAlerts();
		const data = {
			live: true,
			fetchedAt: new Date().toISOString(),
			count: disruptions.length,
			disruptions,
		};
		alertsCache = { at: Date.now(), data };
		return data;
	} catch (err) {
		logger.warn("tec_disruptions_error", { message: err.message });
		// Sert le cache expiré plutôt que null si on l'a.
		if (alertsCache.data) {
			return { ...alertsCache.data, live: false };
		}
		return null;
	}
}

module.exports = {
	isConfigured,
	getNetworkDisruptions,
};
