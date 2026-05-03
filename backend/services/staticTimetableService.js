const fs = require("fs");
const path = require("path");
const readline = require("readline");

const TRIPS_PATH = path.join(__dirname, "..", "trips.txt");
const STOP_TIMES_PATH = path.join(__dirname, "..", "stop_times.txt");
const BRUSSELS_TIMEZONE = "Europe/Brussels";

let tripsIndexPromise = null;
const stopScheduleCache = new Map();

function parseCsvLine(line) {
	const values = [];
	let current = "";
	let inQuotes = false;

	for (let index = 0; index < line.length; index += 1) {
		const char = line[index];
		const next = line[index + 1];

		if (char === "\"") {
			if (inQuotes && next === "\"") {
				current += "\"";
				index += 1;
			} else {
				inQuotes = !inQuotes;
			}
			continue;
		}

		if (char === "," && !inQuotes) {
			values.push(current);
			current = "";
			continue;
		}

		current += char;
	}

	values.push(current);
	return values;
}

function normalizeLine(line) {
	return String(line || "").trim().toUpperCase();
}

function parseGtfsMinutes(timeValue) {
	if (typeof timeValue !== "string" || !timeValue.trim()) return null;
	const [hoursRaw, minutesRaw, secondsRaw = "0"] = timeValue.split(":");
	const hours = Number.parseInt(hoursRaw, 10);
	const minutes = Number.parseInt(minutesRaw, 10);
	const seconds = Number.parseInt(secondsRaw, 10);

	if ([hours, minutes, seconds].some((value) => Number.isNaN(value))) {
		return null;
	}

	return (hours * 60) + minutes + (seconds / 60);
}

function getBrusselsMinutesNow() {
	const formatter = new Intl.DateTimeFormat("en-GB", {
		timeZone: BRUSSELS_TIMEZONE,
		hour12: false,
		hour: "2-digit",
		minute: "2-digit",
	});
	const parts = formatter.formatToParts(new Date());
	const hour = Number.parseInt(parts.find((part) => part.type === "hour")?.value || "0", 10);
	const minute = Number.parseInt(parts.find((part) => part.type === "minute")?.value || "0", 10);
	return (hour * 60) + minute;
}

function computeUpcomingMinutes(gtfsMinutes, minutesNow) {
	if (!Number.isFinite(gtfsMinutes)) return null;

	const candidates = [gtfsMinutes];
	if (gtfsMinutes >= 24 * 60) {
		candidates.push(gtfsMinutes - (24 * 60));
	}

	let best = Number.POSITIVE_INFINITY;
	for (const candidate of candidates) {
		let delta = candidate - minutesNow;
		if (delta < 0) delta += 24 * 60;
		best = Math.min(best, delta);
	}

	return Number.isFinite(best) ? Math.round(best) : null;
}

async function loadTripsIndex() {
	if (tripsIndexPromise) return tripsIndexPromise;

	tripsIndexPromise = (async () => {
		const index = new Map();
		const stream = fs.createReadStream(TRIPS_PATH, "utf8");
		const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
		let isHeader = true;

		for await (const line of rl) {
			if (isHeader) {
				isHeader = false;
				continue;
			}

			if (!line.trim()) continue;
			const [routeId, _serviceId, tripId, headsign] = parseCsvLine(line);
			if (!tripId) continue;
			index.set(tripId, {
				line: normalizeLine(routeId),
				destination: headsign || null,
			});
		}

		return index;
	})();

	return tripsIndexPromise;
}

async function ensureStopSchedules(stopIds = []) {
	const normalizedStopIds = [...new Set(stopIds.map((value) => String(value || "").trim()).filter(Boolean))];
	const missingStopIds = normalizedStopIds.filter((stopId) => !stopScheduleCache.has(stopId));
	if (!missingStopIds.length) return;

	const missingSet = new Set(missingStopIds);
	const collected = new Map(missingStopIds.map((stopId) => [stopId, []]));
	const tripsIndex = await loadTripsIndex();
	const stream = fs.createReadStream(STOP_TIMES_PATH, "utf8");
	const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
	let isHeader = true;

	for await (const line of rl) {
		if (isHeader) {
			isHeader = false;
			continue;
		}

		if (!line.trim()) continue;
		const [tripId, _arrivalTime, departureTime, stopId] = parseCsvLine(line);
		if (!missingSet.has(stopId)) continue;

		const trip = tripsIndex.get(tripId);
		if (!trip?.line) continue;

		const departureMinutes = parseGtfsMinutes(departureTime);
		if (departureMinutes === null) continue;

		collected.get(stopId).push({
			line: trip.line,
			destination: trip.destination,
			departureMinutes,
		});
	}

	for (const stopId of missingStopIds) {
		stopScheduleCache.set(stopId, collected.get(stopId) || []);
	}
}

async function getScheduledStopDepartures({ stopIds = [], line = null, limit = 6 } = {}) {
	const normalizedStopIds = [...new Set(stopIds.map((value) => String(value || "").trim()).filter(Boolean))];
	if (!normalizedStopIds.length) return [];

	await ensureStopSchedules(normalizedStopIds);

	const lineFilter = line ? normalizeLine(line) : null;
	const minutesNow = getBrusselsMinutesNow();
	const seen = new Set();
	const departures = filterUnique(
		normalizedStopIds
		.flatMap((stopId) => stopScheduleCache.get(stopId) || [])
		.filter((entry) => !lineFilter || entry.line === lineFilter)
		.map((entry) => {
			const minutes = computeUpcomingMinutes(entry.departureMinutes, minutesNow);
			return minutes === null ? null : {
				line: entry.line,
				destination: entry.destination,
				minutes,
				source: "scheduled",
			};
		})
		.filter(Boolean)
		.sort((left, right) => left.minutes - right.minutes),
		(entry) => {
			const key = `${entry.line}|${entry.destination || ""}|${entry.minutes}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		}
	);

	return departures.slice(0, limit);
}

function filterUnique(items, predicate) {
	const output = [];
	for (const item of items) {
		if (predicate(item)) {
			output.push(item);
		}
	}
	return output;
}

module.exports = {
	getScheduledStopDepartures,
};
