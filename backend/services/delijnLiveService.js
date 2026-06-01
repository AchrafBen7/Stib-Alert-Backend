// De Lijn temps réel — réutilise le même pattern qu'irailService.js :
// fetch lazy, cache mémoire avec TTL, User-Agent identifiant, timeout court.
// Zéro impact sur le quota Mobility API (séparée).
//
// Endpoint principal : `api.delijn.be/DLKernOpenData/api/v1`
// Auth : header `Ocp-Apim-Subscription-Key` (clé Azure APIM).
// Identifiants : un arrêt De Lijn = (entiteitnummer, haltenummer). Le 1er
// chiffre du haltenummer encode l'entité (1=Antwerpen, 2=Oost-Vlaanderen,
// 3=Vlaams-Brabant/Bruxelles, 4=Limburg, 5=West-Vlaanderen). Vérifié sur les
// 30 477 stops de notre catalogue : distribution propre 1xxxxx → 5xxxxx.
//
// Rate limits De Lijn (en mai 2026) :
//   - 240 req/min Kernel API → c'est le goulot ; cache 60s/arrêt permet
//     une centaine d'utilisateurs simultanés sans saturer
//   - 864 000 req/jour → impossible à atteindre en pratique
//
// Si la clé n'est pas configurée OU si l'API tombe, on retombe sur le
// snapshot statique servi par operatorTransitService — l'app continue à
// marcher en mode dégradé.

const logger = require("./logger");

const BASE_URL = "https://api.delijn.be/DLKernOpenData/api/v1";
const REALTIME_TTL_MS = 60_000;
const DISRUPTIONS_TTL_MS = 180_000;
const REQUEST_TIMEOUT_MS = 8_000;
const USER_AGENT = "StibAlert/1.0 (TFE student project; +https://github.com/AchrafBen7/StibAlert)";

const realtimeCache = new Map(); // halteKey -> { at, data }
const stopDisruptionsCache = new Map();
const stopInfoCache = new Map();
let networkDisruptionsCache = { at: 0, data: null };

function apiKey() {
	return process.env.DELIJN_API_KEY || "";
}

// "gs:delijn:303921" | "303921" → { entity: 3, halte: "303921" }
// Renvoie null si l'ID n'a pas le format attendu (préfixe 1-5, 6 chiffres).
function parseHalteId(rawId) {
	const digits = String(rawId).split(":").pop();
	if (!/^[1-5]\d{5}$/.test(digits)) return null;
	return { entity: digits[0], halte: digits };
}

async function getJSON(path) {
	if (typeof fetch !== "function") {
		throw new Error("global fetch unavailable (Node 18+ required)");
	}
	const key = apiKey();
	if (!key) throw new Error("DELIJN_API_KEY not configured");

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		const res = await fetch(`${BASE_URL}${path}`, {
			signal: controller.signal,
			headers: {
				"Ocp-Apim-Subscription-Key": key,
				"User-Agent": USER_AGENT,
				Accept: "application/json",
			},
		});
		if (!res.ok) {
			throw new Error(`De Lijn HTTP ${res.status} on ${path}`);
		}
		return await res.json();
	} finally {
		clearTimeout(timer);
	}
}

function nowMs() {
	return Date.now();
}

// --- Real-time passages ----------------------------------------------------

/** Normalise un objet "doorkomst" (passage) en forme stable pour l'iOS. */
function mapDoorkomst(d) {
	const scheduled = d.dienstregelingTijdstip || null;
	const predicted = d["real-timeTijdstip"] || null;
	let delayMin = null;
	if (scheduled && predicted) {
		delayMin = Math.round((new Date(predicted) - new Date(scheduled)) / 60000);
	}
	return {
		line: String(d.lijnnummer || "").trim(),
		entity: String(d.entiteitnummer || ""),
		direction: d.richting || null,
		destination: d.bestemmingKortFrans || d.bestemmingKort || d.bestemming || "",
		destinationNl: d.bestemming || null,
		scheduledAt: scheduled,
		predictedAt: predicted,
		delayMin,
		hasRealtime: Array.isArray(d.predictionStatussen) && d.predictionStatussen.includes("REALTIME"),
		tripId: d.ritnummer || null,
	};
}

function firstText(...values) {
	for (const value of values) {
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return "";
}

function normalizeLineCandidate(raw) {
	if (!raw || typeof raw !== "object") return null;
	const line = firstText(raw.lijnnummer, raw.lijnNummer, raw.lijn, raw.nummer, raw.shortName);
	if (!line) return null;
	const direction = raw.richting == null ? null : String(raw.richting);
	const destination = firstText(
		raw.bestemmingKortFrans,
		raw.bestemmingKort,
		raw.bestemming,
		raw.omschrijving,
		raw.lijnrichtingOmschrijving,
		raw.destination
	);
	return { line, direction, destination };
}

function uniqueLines(lines) {
	const seen = new Set();
	return lines.filter((line) => {
		const key = `${line.line}|${line.direction || ""}|${line.destination || ""}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function extractStopLines(json) {
	const containers = [
		json.lijnrichtingen,
		json.lijnRichtingen,
		json.lijnen,
		json.lijninfo,
		json.halte?.lijnrichtingen,
		json.halte?.lijnen,
		json.haltes?.[0]?.lijnrichtingen,
		json.haltes?.[0]?.lijnen,
	].filter(Array.isArray);

	const lines = [];
	for (const arr of containers) {
		for (const item of arr) {
			const normalized = normalizeLineCandidate(item);
			if (normalized) lines.push(normalized);
		}
	}
	return uniqueLines(lines);
}

async function fetchStopRealtime(parsed) {
	const json = await getJSON(`/haltes/${parsed.entity}/${parsed.halte}/real-time`);
	const groups = Array.isArray(json.halteDoorkomsten) ? json.halteDoorkomsten : [];
	const passages = [];
	for (const g of groups) {
		for (const d of g.doorkomsten || []) {
			passages.push(mapDoorkomst(d));
		}
	}
	// Trie par heure prédite (à défaut, heure prévue).
	passages.sort((a, b) => {
		const ta = new Date(a.predictedAt || a.scheduledAt || 0).getTime();
		const tb = new Date(b.predictedAt || b.scheduledAt || 0).getTime();
		return ta - tb;
	});
	return {
		stopId: parsed.halte,
		entity: parsed.entity,
		live: true,
		fetchedAt: new Date().toISOString(),
		passages,
	};
}

async function getStopRealtime(rawId) {
	const parsed = parseHalteId(rawId);
	if (!parsed) return { error: "Identifiant De Lijn invalide.", live: false, passages: [] };

	const cached = realtimeCache.get(parsed.halte);
	if (cached && nowMs() - cached.at < REALTIME_TTL_MS) {
		return cached.data;
	}

	try {
		const data = await fetchStopRealtime(parsed);
		realtimeCache.set(parsed.halte, { at: nowMs(), data });
		return data;
	} catch (err) {
		logger.warn("delijn_realtime_error", { stopId: parsed.halte, message: err.message });
		// Si on a un cache plus ancien on le sert plutôt qu'un vide, sinon
		// on dit honnêtement qu'on est dégradé.
		if (cached) return { ...cached.data, live: false, fetchedAt: new Date(cached.at).toISOString() };
		return {
			stopId: parsed.halte,
			entity: parsed.entity,
			live: false,
			fetchedAt: new Date().toISOString(),
			passages: [],
			error: err.message,
		};
	}
}

async function getStopInfo(rawId) {
	const parsed = parseHalteId(rawId);
	if (!parsed) {
		return { error: "Identifiant De Lijn invalide.", live: false, lines: [] };
	}

	const cached = stopInfoCache.get(parsed.halte);
	if (cached && nowMs() - cached.at < DISRUPTIONS_TTL_MS) {
		return cached.data;
	}

	try {
		// FIX — on interroge /lijnrichtingen (qui liste les lignes + direction
		// + destination desservant l'arrêt) au lieu de /haltes/:ent/:halte
		// (base) qui ne renvoie QUE des liens, sans lignes inline → la section
		// "Lignes à cet arrêt" restait vide. /lijnrichtingen fonctionne 24/7,
		// indépendamment des horaires, donc l'utilisateur voit toujours quelles
		// lignes passent + vers où, même la nuit quand le real-time est vide.
		const json = await getJSON(`/haltes/${parsed.entity}/${parsed.halte}/lijnrichtingen`);
		const data = {
			stopId: parsed.halte,
			entity: parsed.entity,
			live: true,
			fetchedAt: new Date().toISOString(),
			lines: extractStopLines(json),
		};
		stopInfoCache.set(parsed.halte, { at: nowMs(), data });
		return data;
	} catch (err) {
		logger.warn("delijn_stop_info_error", { stopId: parsed.halte, message: err.message });
		if (cached) return { ...cached.data, live: false, fetchedAt: new Date(cached.at).toISOString() };
		return {
			stopId: parsed.halte,
			entity: parsed.entity,
			live: false,
			fetchedAt: new Date().toISOString(),
			lines: [],
			error: err.message,
		};
	}
}

// --- Disruptions / déviations ---------------------------------------------

/** Normalise une "omleiding" (déviation) en gardant la traduction FR. */
function mapOmleiding(o) {
	const titel = o.titelMeertalig?.frans || o.titel || "Déviation";
	const desc = o.omschrijvingMeertalig?.frans || o.omschrijving || "";
	const affectedLines = (o.lijnrichtingen || []).map((lr) => ({
		entity: lr.entiteitnummer,
		line: String(lr.lijnnummer),
		direction: lr.richting,
		description: lr.omschrijving || null,
	}));
	const affectedStops = (o.haltes || []).map((h) => ({
		entity: h.entiteitnummer,
		halte: h.haltenummer,
	}));
	return {
		id: String(o.referentieOmleiding ?? ""),
		title: titel,
		description: desc,
		startDate: o.periode?.startDatum || null,
		endDate: o.periode?.eindDatum || null,
		affectedLines,
		affectedStops,
	};
}

/** Toutes les déviations De Lijn en cours. Remplace le snapshot mai-2025. */
async function getNetworkDisruptions() {
	if (networkDisruptionsCache.data && nowMs() - networkDisruptionsCache.at < DISRUPTIONS_TTL_MS) {
		return networkDisruptionsCache.data;
	}
	try {
		const json = await getJSON("/omleidingen");
		const arr = Array.isArray(json.omleidingen) ? json.omleidingen : [];
		const data = {
			live: true,
			fetchedAt: new Date().toISOString(),
			count: arr.length,
			disruptions: arr.map(mapOmleiding),
		};
		networkDisruptionsCache = { at: nowMs(), data };
		return data;
	} catch (err) {
		logger.warn("delijn_disruptions_error", { message: err.message });
		if (networkDisruptionsCache.data) {
			return { ...networkDisruptionsCache.data, live: false };
		}
		return null;
	}
}

/** Déviations + storingen pour un arrêt précis. */
async function getStopDisruptions(rawId) {
	const parsed = parseHalteId(rawId);
	if (!parsed) return null;

	const cacheKey = parsed.halte;
	const cached = stopDisruptionsCache.get(cacheKey);
	if (cached && nowMs() - cached.at < DISRUPTIONS_TTL_MS) {
		return cached.data;
	}

	try {
		const [oms, sts] = await Promise.all([
			getJSON(`/haltes/${parsed.entity}/${parsed.halte}/omleidingen`).catch(() => ({})),
			getJSON(`/haltes/${parsed.entity}/${parsed.halte}/storingen`).catch(() => ({})),
		]);
		const omleidingen = (oms.omleidingen || []).map(mapOmleiding);
		const storingen = (sts.storingen || []).map((s) => ({
			id: String(s.referentieStoring ?? ""),
			title: s.titelMeertalig?.frans || s.titel || "Panne",
			description: s.omschrijvingMeertalig?.frans || s.omschrijving || "",
			startDate: s.periode?.startDatum || null,
		}));
		const data = {
			stopId: parsed.halte,
			entity: parsed.entity,
			live: true,
			fetchedAt: new Date().toISOString(),
			omleidingen,
			storingen,
		};
		stopDisruptionsCache.set(cacheKey, { at: nowMs(), data });
		return data;
	} catch (err) {
		logger.warn("delijn_stop_disruptions_error", { stopId: parsed.halte, message: err.message });
		return cached?.data || null;
	}
}

module.exports = {
	parseHalteId,
	getStopRealtime,
	getStopInfo,
	getNetworkDisruptions,
	getStopDisruptions,
	isConfigured: () => Boolean(apiKey()),
};
