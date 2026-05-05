const fs = require("fs");
const crypto = require("crypto");
const os = require("os");
const path = require("path");
const redis = require("../config/redis");

const DEFAULT_BASE_URL = "https://api.belgianmobility.io";
const DEFAULT_API_KEY_HEADER = "x-api-key";
const AZURE_APIM_API_KEY_HEADER = "bmc-partner-key";
const STALE_CACHE_SUFFIX = ":stale";
const MIN_STALE_TTL_SECONDS = 5 * 60;
const MAX_STALE_TTL_SECONDS = 24 * 60 * 60;

// TTL in seconds for each endpoint — these are the only knobs to adjust
const CACHE_TTL = {
	TravellersInformation: 120,  // 2 min — changes rarely, high quota cost
	WaitingTimes:          20,   // 20 s — real-time, cache short
	VehiclePositions:      15,   // 15 s — real-time
	ShapeFiles:            3600, // 1 h  — static
	StopDetails:           3600, // 1 h  — static
};

const localCache = new Map();
const inFlightRequests = new Map();
const rateLimitedUntil = new Map();
let localTravellersSnapshotCache = null;

const LOCAL_TRAVELLERS_SNAPSHOT_CANDIDATES = [
	process.env.STIB_TRAVELLERS_INFORMATION_SNAPSHOT_PATH,
	path.join(process.cwd(), "data", "stib-travellers-information.json"),
	path.join(process.cwd(), "stib-travellers-information.json"),
	path.join(os.homedir(), "Downloads", "stib-travellers-information.json"),
].filter(Boolean);

function nowMs() {
	return Date.now();
}

function buildLocalCacheEntry(value, ttlSeconds) {
	return {
		value,
		expiresAt: nowMs() + Math.max(ttlSeconds, 0) * 1000,
	};
}

function getLocalCachedValue(key, { allowExpired = false } = {}) {
	const entry = localCache.get(key);
	if (!entry) return null;
	if (entry.expiresAt > nowMs()) return entry.value;
	if (allowExpired) return entry.value;
	localCache.delete(key);
	return null;
}

function setLocalCachedValue(key, value, ttlSeconds) {
	localCache.set(key, buildLocalCacheEntry(value, ttlSeconds));
}

function computeStaleTtlSeconds(ttlSeconds) {
	return Math.min(Math.max(ttlSeconds * 12, MIN_STALE_TTL_SECONDS), MAX_STALE_TTL_SECONDS);
}

async function readCachedValue(cacheKey) {
	const localValue = getLocalCachedValue(cacheKey);
	if (localValue !== null) return localValue;

	if (redis) {
		try {
			const cached = await redis.get(cacheKey);
			if (cached) {
				const parsed = JSON.parse(cached);
				setLocalCachedValue(cacheKey, parsed, 5);
				return parsed;
			}
		} catch (_) {
			// Redis read failure → fall through
		}
	}

	return null;
}

async function readStaleCachedValue(cacheKey) {
	const staleKey = `${cacheKey}${STALE_CACHE_SUFFIX}`;
	const localValue = getLocalCachedValue(staleKey, { allowExpired: true });
	if (localValue !== null) return localValue;

	if (redis) {
		try {
			const cached = await redis.get(staleKey);
			if (cached) {
				const parsed = JSON.parse(cached);
				setLocalCachedValue(staleKey, parsed, computeStaleTtlSeconds(30));
				return parsed;
			}
		} catch (_) {
			// Redis read failure → fall through
		}
	}

	return null;
}

async function writeCachedValue(cacheKey, value, ttlSeconds) {
	setLocalCachedValue(cacheKey, value, ttlSeconds);
	setLocalCachedValue(`${cacheKey}${STALE_CACHE_SUFFIX}`, value, computeStaleTtlSeconds(ttlSeconds));

	if (redis && ttlSeconds > 0) {
		const staleTtlSeconds = computeStaleTtlSeconds(ttlSeconds);
		Promise.allSettled([
			redis.set(cacheKey, JSON.stringify(value), "EX", ttlSeconds),
			redis.set(`${cacheKey}${STALE_CACHE_SUFFIX}`, JSON.stringify(value), "EX", staleTtlSeconds),
		]).catch(() => {});
	}
}

function getCooldownRemainingSeconds(cacheKey) {
	const blockedUntil = rateLimitedUntil.get(cacheKey) || 0;
	return Math.max(Math.ceil((blockedUntil - nowMs()) / 1000), 0);
}

function setRateLimitCooldown(cacheKey, retryAfterSeconds) {
	const seconds = retryAfterSeconds && retryAfterSeconds > 0 ? retryAfterSeconds : 15;
	rateLimitedUntil.set(cacheKey, nowMs() + seconds * 1000);
}

function buildRateLimitError(cacheKey) {
	const retryAfter = getCooldownRemainingSeconds(cacheKey);
	const error = new Error("Belgian Mobility API cooldown active");
	error.status = 429;
	error.details = JSON.stringify({
		statusCode: 429,
		message: `Rate limit cooldown active. Try again in ${retryAfter} seconds.`,
	});
	error.retryAfter = retryAfter;
	error.isQuotaExceeded = false;
	return error;
}

async function cachedRequest(cacheKey, ttlSeconds, fetchFn) {
	const cached = await readCachedValue(cacheKey);
	if (cached !== null) return cached;

	if (getCooldownRemainingSeconds(cacheKey) > 0) {
		const stale = await readStaleCachedValue(cacheKey);
		if (stale !== null) return stale;
		throw buildRateLimitError(cacheKey);
	}

	const pending = inFlightRequests.get(cacheKey);
	if (pending) return pending;

	const work = (async () => {
		try {
			const result = await fetchFn();
			rateLimitedUntil.delete(cacheKey);
			await writeCachedValue(cacheKey, result, ttlSeconds);
			return result;
		} catch (error) {
			if (error.status === 429 || error.isQuotaExceeded) {
				setRateLimitCooldown(cacheKey, error.retryAfter);
				const stale = await readStaleCachedValue(cacheKey);
				if (stale !== null) return stale;
			}
			throw error;
		} finally {
			inFlightRequests.delete(cacheKey);
		}
	})();

	inFlightRequests.set(cacheKey, work);
	return work;
}

function getFetch() {
	if (typeof fetch !== "function") {
		throw new Error("Global fetch n'est pas disponible. Utilise Node.js 18+ pour Belgian Mobility.");
	}

	return fetch;
}

function getBaseUrl() {
	return (process.env.BELGIAN_MOBILITY_API_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function isMobilityTwinBaseUrl() {
	return /api\.mobilitytwin\.brussels$/i.test(getBaseUrl());
}

function isAzureApimBaseUrl() {
	return /api-management-opendata-production\.azure-api\.net$/i.test(getBaseUrl());
}

function buildHeaders() {
	const headers = {
		Accept: "application/json",
	};

	const apiKey = process.env.BELGIAN_MOBILITY_API_KEY;
	const apiKeyHeader =
		process.env.BELGIAN_MOBILITY_API_KEY_HEADER ||
		(isAzureApimBaseUrl() ? AZURE_APIM_API_KEY_HEADER : DEFAULT_API_KEY_HEADER);
	const bearerToken = process.env.BELGIAN_MOBILITY_BEARER_TOKEN;

	if (apiKey) {
		headers[apiKeyHeader] = apiKey;
	}

	if (bearerToken) {
		headers.Authorization = `Bearer ${bearerToken}`;
	}

	return headers;
}

function buildUrl(pathname, query = {}) {
	const baseUrl = getBaseUrl();
	const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
	const url = new URL(`${baseUrl}${normalizedPath}`);

	Object.entries(query).forEach(([key, value]) => {
		if (value === undefined || value === null || value === "") return;

		if (Array.isArray(value)) {
			value.forEach((entry) => {
				if (entry !== undefined && entry !== null && entry !== "") {
					url.searchParams.append(key, String(entry));
				}
			});
			return;
		}

		url.searchParams.set(key, String(value));
	});

	return url;
}

function extractItems(payload) {
	if (Array.isArray(payload)) return payload;
	if (Array.isArray(payload?.results)) return payload.results;
	if (Array.isArray(payload?.records)) return payload.records;
	if (Array.isArray(payload?.items)) return payload.items;
	if (Array.isArray(payload?.data)) return payload.data;
	if (Array.isArray(payload?.features)) return payload.features;
	return [];
}

function toArray(value) {
	if (Array.isArray(value)) return value;
	if (value === undefined || value === null || value === "") return [];
	return [value];
}

function parseJsonIfNeeded(value) {
	if (typeof value !== "string") return value;
	const trimmed = value.trim();
	if (!trimmed) return value;
	if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return value;

	try {
		return JSON.parse(trimmed);
	} catch {
		return value;
	}
}

function pickLocalizedText(value, preferredLangs = ["fr", "en", "nl"]) {
	const parsed = parseJsonIfNeeded(value);

	if (typeof parsed === "string") return parsed;

	if (Array.isArray(parsed)) {
		for (const item of parsed) {
			const text = pickLocalizedText(item, preferredLangs);
			if (text) return text;
		}
		return null;
	}

	if (!parsed || typeof parsed !== "object") return null;

	if (Array.isArray(parsed.text)) {
		for (const entry of parsed.text) {
			const text = pickLocalizedText(entry, preferredLangs);
			if (text) return text;
		}
	}

	for (const lang of preferredLangs) {
		const candidate = parsed[lang];
		if (typeof candidate === "string" && candidate.trim()) return candidate;
	}

	for (const candidate of Object.values(parsed)) {
		if (typeof candidate === "string" && candidate.trim()) return candidate;
	}

	return null;
}

function containsOneOf(values, queryValues) {
	if (!queryValues.length) return true;

	const haystack = toArray(values)
		.flatMap((value) => (typeof value === "object" && value !== null ? Object.values(value) : [value]))
		.map((value) => String(value).toLowerCase());

	return queryValues.some((query) => haystack.some((value) => value.includes(query)));
}

function normalizeTravellerInformation(entry) {
	const parsedLines = parseJsonIfNeeded(entry.lines);
	const parsedStops = parseJsonIfNeeded(entry.points || entry.stops || entry.stop);
	const parsedContent = parseJsonIfNeeded(entry.content);
	const localizedText = pickLocalizedText(parsedContent);

	const normalizedLines = Array.isArray(parsedLines)
		? parsedLines.map((line) => {
			if (typeof line === "string") return line;
			if (line && typeof line === "object") {
				return line.id || line.lineId || line.lineid || line.name || null;
			}
			return null;
		}).filter(Boolean)
		: (entry.line || entry.routes || parsedLines || []);

	const normalizedStops = Array.isArray(parsedStops)
		? parsedStops.map((stop) => {
			if (typeof stop === "string") return stop;
			if (stop && typeof stop === "object") {
				return stop.id || stop.pointid || stop.pointId || stop.name || null;
			}
			return null;
		}).filter(Boolean)
		: (parsedStops || []);

	return {
		id: entry.id || entry._id || entry.messageid || entry.messageId || null,
		title: entry.title || entry.titre || entry.header || entry.cause || localizedText || null,
		description: entry.description || entry.message || entry.text || localizedText || entry.content || null,
		lines: normalizedLines,
		stops: normalizedStops,
		priority: entry.priority || entry.severity || entry.level || null,
		language: entry.language || entry.lang || null,
		updatedAt: entry.updatedAt || entry.updated_at || entry.timestamp || entry.last_update || null,
		raw: entry,
	};
}

function stableSnapshotMessageId(message, index) {
	if (message.id) return String(message.id);
	const signature = JSON.stringify({
		lines: message.lines || [],
		stopIds: message.stopIds || message.points || [],
		text: message.text || message.content || "",
		priority: message.priority || null,
		index,
	});
	return `snapshot-${crypto.createHash("sha1").update(signature).digest("hex").slice(0, 16)}`;
}

function readLocalTravellersSnapshotFile() {
	if (localTravellersSnapshotCache) {
		return localTravellersSnapshotCache;
	}

	for (const candidate of LOCAL_TRAVELLERS_SNAPSHOT_CANDIDATES) {
		try {
			if (!fs.existsSync(candidate)) continue;
			const parsed = JSON.parse(fs.readFileSync(candidate, "utf8"));
			localTravellersSnapshotCache = {
				path: candidate,
				payload: parsed,
			};
			return localTravellersSnapshotCache;
		} catch (error) {
			console.warn(`[belgianMobility] invalid local travellers snapshot at ${candidate}: ${error.message}`);
		}
	}

	return null;
}

function extractSnapshotLocalizedText(text) {
	if (!text || typeof text !== "object") return null;

	const groups = Object.values(text);
	for (const group of groups) {
		if (!Array.isArray(group)) continue;
		for (const entry of group) {
			const localized = pickLocalizedText(entry);
			if (localized) return localized;
		}
	}

	return null;
}

function loadLocalTravellersInformationSnapshot(query = {}) {
	const snapshot = readLocalTravellersSnapshotFile();
	if (!snapshot) return null;

	const lineFilters = toArray(query.line || query.lines).map((value) => String(value).toLowerCase());
	const stopFilters = toArray(query.stopId || query.stop || query.pointid).map((value) => String(value).toLowerCase());
	const languageFilters = toArray(query.language || query.lang).map((value) => String(value).toLowerCase());

	const items = toArray(snapshot.payload.messages)
		.map((message, index) => ({
			id: stableSnapshotMessageId(message, index),
			title: extractSnapshotLocalizedText(message.text) || "Information STIB",
			description: extractSnapshotLocalizedText(message.text) || "Information STIB",
			lines: toArray(message.lines),
			stops: toArray(message.stopIds),
			priority: message.priority || null,
			language: null,
			updatedAt: snapshot.payload.fetchedAt || null,
			raw: message,
		}))
		.filter((entry) => containsOneOf(entry.lines, lineFilters))
		.filter((entry) => containsOneOf(entry.stops, stopFilters))
		.filter((entry) => containsOneOf(entry.language, languageFilters));

	return {
		payload: {
			source: "local_snapshot",
			path: snapshot.path,
			fetchedAt: snapshot.payload.fetchedAt || null,
		},
		items,
	};
}

function normalizeWaitingTime(entry) {
	const passingTimes = parseJsonIfNeeded(entry.passingtimes);
	const firstPassingTime = Array.isArray(passingTimes) ? passingTimes[0] : null;
	const destination = pickLocalizedText(firstPassingTime?.destination);
	let minutes = entry.minutes || entry.waitingTime || entry.waiting_time || entry.remaining_time || null;

	if (minutes === null && firstPassingTime?.expectedArrivalTime) {
		const etaMs = new Date(firstPassingTime.expectedArrivalTime).getTime() - Date.now();
		if (Number.isFinite(etaMs)) {
			minutes = Math.max(Math.round(etaMs / 60000), 0);
		}
	}

	return {
		stopId: entry.stopId || entry.stop_id || entry.pointid || entry.pointId || null,
		stopName: entry.stopName || entry.stop_name || entry.name || pickLocalizedText(entry.name) || null,
		line: entry.line || entry.lineid || entry.lineId || entry.route || null,
		destination: entry.destination || entry.headsign || destination || null,
		minutes,
		raw: entry,
	};
}

function normalizeVehiclePosition(entry) {
	const properties = entry.properties || entry.fields || entry.attributes || entry;

	return {
		vehicleId: properties.vehicleId || properties.vehicle_id || properties.uuid || entry.id || null,
		line: properties.line || properties.lineid || properties.lineId || properties.route || null,
		direction: properties.direction || properties.headsign || properties.destination || null,
		latitude:
			properties.latitude ||
			properties.lat ||
			properties.position?.latitude ||
			entry.geometry?.coordinates?.[1] ||
			null,
		longitude:
			properties.longitude ||
			properties.lon ||
			properties.lng ||
			properties.position?.longitude ||
			entry.geometry?.coordinates?.[0] ||
			null,
		updatedAt: properties.updatedAt || properties.updated_at || properties.timestamp || null,
		raw: entry,
	};
}

function normalizeCoordinatePair(pair) {
	if (!Array.isArray(pair) || pair.length < 2) return null;

	const [longitude, latitude] = pair;
	if (longitude === undefined || latitude === undefined) return null;

	return {
		latitude: Number(latitude),
		longitude: Number(longitude),
	};
}

function flattenLineStrings(coordinates) {
	if (!Array.isArray(coordinates)) return [];

	return coordinates.flatMap((segment) => {
		if (!Array.isArray(segment)) return [];
		return segment.map(normalizeCoordinatePair).filter(Boolean);
	}).filter((segment) => segment.length > 0);
}

function extractShapeGeometry(entry) {
	const geometry =
		entry.geometry ||
		entry.geom ||
		entry.geo_shape ||
		entry.geojson ||
		entry.shape ||
		null;

	if (!geometry) return [];

	if (geometry.type === "LineString") {
		const line = toArray(geometry.coordinates).map(normalizeCoordinatePair).filter(Boolean);
		return line.length ? [line] : [];
	}

	if (geometry.type === "MultiLineString") {
		return flattenLineStrings(geometry.coordinates);
	}

	return [];
}

function normalizeShapeFile(entry) {
	const properties = entry.properties || entry.fields || entry.attributes || entry;
	const polylines = extractShapeGeometry(entry);

	return {
		id: entry.id || entry._id || properties.id || properties.objectid || null,
		line: properties.line || properties.lineid || properties.lineId || properties.route || properties.route_id || properties.ligne || null,
		transportType: properties.transportType || properties.mode || properties.type || properties.network || null,
		direction: properties.direction || properties.destination || properties.headsign || null,
		polylines,
		raw: entry,
	};
}

function normalizeStopDetail(entry) {
	const properties = entry.properties || entry.fields || entry.attributes || entry;

	return {
		id: entry.id || entry._id || properties.id || properties.stopId || properties.stop_id || properties.pointid || properties.pointId || null,
		name: pickLocalizedText(properties.name) || properties.name || properties.stopName || properties.stop_name || properties.description || null,
		latitude:
			properties.latitude ||
			properties.lat ||
			parseJsonIfNeeded(properties.gpscoordinates)?.latitude ||
			properties.location?.latitude ||
			entry.geometry?.coordinates?.[1] ||
			null,
		longitude:
			properties.longitude ||
			properties.lon ||
			properties.lng ||
			parseJsonIfNeeded(properties.gpscoordinates)?.longitude ||
			properties.location?.longitude ||
			entry.geometry?.coordinates?.[0] ||
			null,
		raw: entry,
	};
}

async function requestDataset(pathname, query = {}) {
	const requestUrl = buildUrl(pathname, query);
	const response = await getFetch()(requestUrl, {
		method: "GET",
		headers: buildHeaders(),
	});

	if (!response.ok) {
		const errorText = await response.text();
		const error = new Error(`Belgian Mobility API error ${response.status}`);
		error.status = response.status;
		error.details = errorText;
		error.requestUrl = requestUrl.toString();
		error.retryAfter = Number.parseInt(response.headers.get("retry-after") || "", 10) || null;
		error.isQuotaExceeded =
			response.status === 403 &&
			/quota exceeded|out of call volume quota/i.test(errorText);
		throw error;
	}

	return response.json();
}

async function getTravellersInformation(query = {}) {
	const cacheKey = `stib:TravellersInformation`;
	try {
		const payload = await cachedRequest(cacheKey, CACHE_TTL.TravellersInformation, () =>
			requestDataset(
				isMobilityTwinBaseUrl() ? "/stib/travellers-information" : "/api/datasets/stibmivb/rt/TravellersInformation",
				query
			)
		);
		const items = extractItems(payload);
		const lineFilters = toArray(query.line || query.lines).map((value) => String(value).toLowerCase());
		const stopFilters = toArray(query.stopId || query.stop || query.pointid).map((value) => String(value).toLowerCase());
		const languageFilters = toArray(query.language || query.lang).map((value) => String(value).toLowerCase());

		const normalized = items
			.filter((entry) => containsOneOf(entry.lines || entry.line || entry.routes, lineFilters))
			.filter((entry) => containsOneOf(entry.points || entry.stops || entry.stop, stopFilters))
			.filter((entry) => containsOneOf(entry.language || entry.lang, languageFilters))
			.map(normalizeTravellerInformation);

		return { payload, items: normalized };
	} catch (error) {
		const fallback = loadLocalTravellersInformationSnapshot(query);
		if (fallback) {
			console.warn(`[belgianMobility] TravellersInformation fallback -> local snapshot (${fallback.payload.path})`);
			return fallback;
		}
		throw error;
	}
}

async function getWaitingTimes(query = {}) {
	const stopKey = toArray(query.stopId || query.stop || query.pointid).join(",") || "all";
	const cacheKey = `stib:WaitingTimes:${stopKey}`;
	const payload = await cachedRequest(cacheKey, CACHE_TTL.WaitingTimes, () =>
		requestDataset(
			isMobilityTwinBaseUrl() ? "/stib/waiting-times" : "/api/datasets/stibmivb/rt/WaitingTimes",
			query
		)
	);
	const items = extractItems(payload);
	const stopFilters = toArray(query.stopId || query.stop || query.pointid).map((value) => String(value).toLowerCase());
	const lineFilters = toArray(query.line || query.lines).map((value) => String(value).toLowerCase());

	const normalized = items
		.filter((entry) => containsOneOf(entry.stopId || entry.stop_id || entry.pointid, stopFilters))
		.filter((entry) => containsOneOf(entry.line || entry.lineid || entry.lineId || entry.route, lineFilters))
		.map(normalizeWaitingTime);

	return { payload, items: normalized };
}

async function getVehiclePositions(query = {}) {
	const lineKey = toArray(query.line || query.lines).join(",") || "all";
	const cacheKey = `stib:VehiclePositions:${lineKey}`;
	const payload = await cachedRequest(cacheKey, CACHE_TTL.VehiclePositions, () =>
		requestDataset(
			isMobilityTwinBaseUrl() ? "/stib/vehicle-position" : "/api/datasets/stibmivb/rt/VehiclePositions",
			query
		)
	);
	const items = extractItems(payload);
	const lineFilters = toArray(query.line || query.lines).map((value) => String(value).toLowerCase());

	const normalized = items
		.filter((entry) => containsOneOf(
			entry.line || entry.lineid || entry.lineId || entry.route || entry.properties?.lineId || entry.properties?.lineid,
			lineFilters
		))
		.map(normalizeVehiclePosition);

	return { payload, items: normalized };
}

async function getShapeFiles(query = {}) {
	const lineKey = toArray(query.line || query.lines).join(",") || "all";
	const cacheKey = `stib:ShapeFiles:${lineKey}`;
	const payload = await cachedRequest(cacheKey, CACHE_TTL.ShapeFiles, () =>
		requestDataset(
			isMobilityTwinBaseUrl() ? "/stib/shapefile" : "/api/datasets/stibmivb/static/shape-files",
			query
		)
	);
	const items = extractItems(payload);
	const lineFilters = toArray(query.line || query.lines).map((value) => String(value).toLowerCase());
	const modeFilters = toArray(query.transportType || query.mode || query.type).map((value) => String(value).toLowerCase());

	const normalized = items
		.map(normalizeShapeFile)
		.filter((entry) => containsOneOf(entry.line, lineFilters))
		.filter((entry) => containsOneOf(entry.transportType, modeFilters))
		.filter((entry) => entry.polylines.length > 0);

	return { payload, items: normalized };
}

async function getStopDetails(query = {}) {
	const stopKey = toArray(query.stopId || query.stop || query.pointid).join(",") || "all";
	const cacheKey = `stib:StopDetails:${stopKey}`;
	const payload = await cachedRequest(cacheKey, CACHE_TTL.StopDetails, () =>
		requestDataset(
			isMobilityTwinBaseUrl() ? "/stib/stop-details" : "/api/datasets/stibmivb/static/stopDetails",
			query
		)
	);
	const items = extractItems(payload);
	const stopFilters = toArray(query.stopId || query.stop || query.pointid).map((value) => String(value).toLowerCase());

	const normalized = items
		.map(normalizeStopDetail)
		.filter((entry) => containsOneOf(entry.id, stopFilters))
		.filter((entry) => entry.latitude !== null && entry.longitude !== null);

	return { payload, items: normalized };
}

module.exports = {
	getShapeFiles,
	getStopDetails,
	getTravellersInformation,
	getVehiclePositions,
	getWaitingTimes,
};
