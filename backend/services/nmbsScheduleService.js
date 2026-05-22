const fs = require("fs");
const path = require("path");

// Precomputed (offline, from the NMBS GTFS static) per-gare departures for
// three day-types: wk (weekday), sa (Saturday), su (Sunday). Served from this
// bundled file — zero calls to the Mobility API.
const DATA_PATH = path.join(__dirname, "..", "data", "nmbs-departures.json");

let cache = null;
function load() {
	if (cache) return cache;
	try {
		cache = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
	} catch (error) {
		console.warn("[nmbs] departures dataset unavailable:", error.message);
		cache = { stations: {} };
	}
	return cache;
}

// Current Brussels day-type + minutes-since-midnight (DST-safe via Intl).
function brusselsNow() {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: "Europe/Brussels",
		weekday: "long",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	}).formatToParts(new Date());
	const get = (t) => parts.find((p) => p.type === t)?.value;
	const weekday = get("weekday");
	const minutes = parseInt(get("hour"), 10) * 60 + parseInt(get("minute"), 10);
	const dayType = weekday === "Saturday" ? "sa" : weekday === "Sunday" ? "su" : "wk";
	return { dayType, minutes };
}

function fmt(mins) {
	const h = Math.floor(mins / 60) % 24;
	const m = mins % 60;
	return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
}

function nextDepartures(stationId, limit = 8) {
	const data = load();
	const station = data.stations[stationId];
	const { dayType, minutes } = brusselsNow();
	if (!station) return { stationId, dayType, items: [] };

	const list = station[dayType] || []; // sorted [minutes, destination, line]
	const items = [];
	for (const entry of list) {
		const [mins, destination, line] = entry;
		if (mins < minutes) continue;
		items.push({ minutes: mins, time: fmt(mins), destination, line });
		if (items.length >= limit) break;
	}
	return { stationId, dayType, items };
}

// Full theoretical timetable for a gare: every departure of the day for all
// three day-types (weekday / Saturday / Sunday), so the client can render a
// complete schedule and switch days without re-fetching. Still served from the
// bundled dataset — zero Mobility API calls. `today` tells the client which
// day-type to preselect.
function fullSchedule(stationId) {
	const data = load();
	const station = data.stations[stationId];
	const { dayType } = brusselsNow();
	const mapDay = (list) =>
		(list || []).map(([mins, destination, line]) => ({
			minutes: mins,
			time: fmt(mins),
			destination,
			line,
		}));
	if (!station) {
		return { stationId, today: dayType, days: { wk: [], sa: [], su: [] } };
	}
	return {
		stationId,
		today: dayType,
		days: {
			wk: mapDay(station.wk),
			sa: mapDay(station.sa),
			su: mapDay(station.su),
		},
	};
}

module.exports = { nextDepartures, fullSchedule };
