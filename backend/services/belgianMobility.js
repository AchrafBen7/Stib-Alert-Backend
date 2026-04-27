const redis = require("../config/redis");

const DEFAULT_BASE_URL = "https://api.belgianmobility.io";
const DEFAULT_API_KEY_HEADER = "x-api-key";

// TTL in seconds for each endpoint — these are the only knobs to adjust
const CACHE_TTL = {
	TravellersInformation: 120,  // 2 min — changes rarely, high quota cost
	WaitingTimes:          20,   // 20 s — real-time, cache short
	VehiclePositions:      15,   // 15 s — real-time
	ShapeFiles:            3600, // 1 h  — static
	StopDetails:           3600, // 1 h  — static
};

async function cachedRequest(cacheKey, ttlSeconds, fetchFn) {
	if (redis) {
		try {
			const cached = await redis.get(cacheKey);
			if (cached) return JSON.parse(cached);
		} catch (_) {
			// Redis read failure → fall through to live request
		}
	}

	const result = await fetchFn();

	if (redis && ttlSeconds > 0) {
		redis
			.set(cacheKey, JSON.stringify(result), "EX", ttlSeconds)
			.catch(() => {}); // fire-and-forget, never block on cache write
	}

	return result;
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

function buildHeaders() {
	const headers = {
		Accept: "application/json",
	};

	const apiKey = process.env.BELGIAN_MOBILITY_API_KEY;
	const apiKeyHeader = process.env.BELGIAN_MOBILITY_API_KEY_HEADER || DEFAULT_API_KEY_HEADER;
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
