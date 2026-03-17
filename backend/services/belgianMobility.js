const DEFAULT_BASE_URL = "https://api.belgianmobility.io";
const DEFAULT_API_KEY_HEADER = "x-api-key";

function getFetch() {
	if (typeof fetch !== "function") {
		throw new Error("Global fetch n'est pas disponible. Utilise Node.js 18+ pour Belgian Mobility.");
	}

	return fetch;
}

function getBaseUrl() {
	return (process.env.BELGIAN_MOBILITY_API_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
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

function containsOneOf(values, queryValues) {
	if (!queryValues.length) return true;

	const haystack = toArray(values)
		.flatMap((value) => (typeof value === "object" && value !== null ? Object.values(value) : [value]))
		.map((value) => String(value).toLowerCase());

	return queryValues.some((query) => haystack.some((value) => value.includes(query)));
}

function normalizeTravellerInformation(entry) {
	return {
		id: entry.id || entry._id || entry.messageid || entry.messageId || null,
		title: entry.title || entry.titre || entry.header || entry.cause || null,
		description: entry.description || entry.message || entry.text || entry.content || null,
		lines: entry.lines || entry.line || entry.routes || [],
		stops: entry.points || entry.stops || entry.stop || [],
		priority: entry.priority || entry.severity || entry.level || null,
		language: entry.language || entry.lang || null,
		updatedAt: entry.updatedAt || entry.updated_at || entry.timestamp || entry.last_update || null,
		raw: entry,
	};
}

function normalizeWaitingTime(entry) {
	return {
		stopId: entry.stopId || entry.stop_id || entry.pointid || entry.pointId || null,
		stopName: entry.stopName || entry.stop_name || entry.name || null,
		line: entry.line || entry.lineid || entry.route || null,
		destination: entry.destination || entry.headsign || null,
		minutes: entry.minutes || entry.waitingTime || entry.waiting_time || entry.remaining_time || null,
		raw: entry,
	};
}

function normalizeVehiclePosition(entry) {
	return {
		vehicleId: entry.vehicleId || entry.vehicle_id || entry.id || null,
		line: entry.line || entry.lineid || entry.route || null,
		direction: entry.direction || entry.headsign || null,
		latitude: entry.latitude || entry.lat || entry.position?.latitude || null,
		longitude: entry.longitude || entry.lon || entry.lng || entry.position?.longitude || null,
		updatedAt: entry.updatedAt || entry.updated_at || entry.timestamp || null,
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
		throw error;
	}

	return response.json();
}

async function getTravellersInformation(query = {}) {
	const payload = await requestDataset("/api/datasets/stibmivb/rt/TravellersInformation", query);
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
	const payload = await requestDataset("/api/datasets/stibmivb/rt/WaitingTimes", query);
	const items = extractItems(payload);
	const stopFilters = toArray(query.stopId || query.stop || query.pointid).map((value) => String(value).toLowerCase());
	const lineFilters = toArray(query.line || query.lines).map((value) => String(value).toLowerCase());

	const normalized = items
		.filter((entry) => containsOneOf(entry.stopId || entry.stop_id || entry.pointid, stopFilters))
		.filter((entry) => containsOneOf(entry.line || entry.lineid || entry.route, lineFilters))
		.map(normalizeWaitingTime);

	return { payload, items: normalized };
}

async function getVehiclePositions(query = {}) {
	const payload = await requestDataset("/api/datasets/stibmivb/rt/VehiclePositions", query);
	const items = extractItems(payload);
	const lineFilters = toArray(query.line || query.lines).map((value) => String(value).toLowerCase());

	const normalized = items
		.filter((entry) => containsOneOf(entry.line || entry.lineid || entry.route, lineFilters))
		.map(normalizeVehiclePosition);

	return { payload, items: normalized };
}

module.exports = {
	getTravellersInformation,
	getVehiclePositions,
	getWaitingTimes,
};
