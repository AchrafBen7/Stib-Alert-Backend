const fs = require("fs");
const os = require("os");
const path = require("path");

const BRUSSELS_TIMEZONE = "Europe/Brussels";
const SCHEDULE_PART_PATTERN = /^stib-theoretical-schedules-part-\d+\.json$/i;

let scheduleIndexPromise = null;

function normalizeStopName(value) {
	return String(value || "")
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/\s+/g, " ")
		.trim();
}

function normalizeLine(line) {
	const normalized = String(line || "").trim().toUpperCase();
	return /^T\d+$/.test(normalized) ? normalized.slice(1) : normalized;
}

function parseClockMinutes(value) {
	if (typeof value !== "string" || !value.trim()) return null;
	const [hoursRaw, minutesRaw] = value.split(":");
	const hours = Number.parseInt(hoursRaw, 10);
	const minutes = Number.parseInt(minutesRaw, 10);
	if ([hours, minutes].some((item) => Number.isNaN(item))) return null;
	return (hours * 60) + minutes;
}

function getBrusselsDateParts() {
	const formatter = new Intl.DateTimeFormat("en-GB", {
		timeZone: BRUSSELS_TIMEZONE,
		weekday: "short",
		hour12: false,
		hour: "2-digit",
		minute: "2-digit",
	});

	const parts = formatter.formatToParts(new Date());
	const hour = Number.parseInt(parts.find((part) => part.type === "hour")?.value || "0", 10);
	const minute = Number.parseInt(parts.find((part) => part.type === "minute")?.value || "0", 10);
	const weekday = (parts.find((part) => part.type === "weekday")?.value || "").toLowerCase();

	return {
		minutesNow: (hour * 60) + minute,
		weekdayKey: weekday.startsWith("sat")
			? "saturday"
			: weekday.startsWith("sun")
				? "sunday"
				: "weekday",
	};
}

function computeUpcomingMinutes(scheduleMinutes, minutesNow) {
	if (!Number.isFinite(scheduleMinutes)) return null;
	let delta = scheduleMinutes - minutesNow;
	if (delta < 0) delta += 24 * 60;
	return Math.round(delta);
}

function getScheduleRoots() {
	return [
		process.env.STIB_THEORETICAL_SCHEDULES_DIR,
		path.join(process.cwd(), "data", "theoretical-schedules"),
		path.join(process.cwd(), "data"),
		path.join(process.cwd(), "backend", "data"),
		path.join(os.homedir(), "Downloads"),
	].filter(Boolean);
}

function discoverScheduleFiles() {
	for (const root of getScheduleRoots()) {
		try {
			if (!fs.existsSync(root)) continue;
			const candidates = fs.readdirSync(root)
				.filter((name) => SCHEDULE_PART_PATTERN.test(name))
				.sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
				.map((name) => path.join(root, name));
			if (candidates.length) {
				return candidates;
			}
		} catch (error) {
			console.warn(`[staticTimetable] schedule discovery failed in ${root}: ${error.message}`);
		}
	}

	return [];
}

function buildDepartureEntries({ route, direction, stop }) {
	const line = normalizeLine(route.short_name || route.route_id);
	if (!line) return [];

	const destination = direction.headsign || route.long_name || null;
	const departures = stop.departures || {};
	const entries = [];

	for (const [dayType, times] of Object.entries(departures)) {
		if (!Array.isArray(times)) continue;
		for (const time of times) {
			const scheduleMinutes = parseClockMinutes(time);
			if (scheduleMinutes === null) continue;
			entries.push({
				line,
				destination,
				dayType,
				scheduleMinutes,
				stopName: stop.name || null,
			});
		}
	}

	return entries;
}

async function loadScheduleIndex() {
	if (scheduleIndexPromise) return scheduleIndexPromise;

	scheduleIndexPromise = (async () => {
		const files = discoverScheduleFiles();
		if (!files.length) {
			console.warn("[staticTimetable] no theoretical schedule files found");
			return { byStopId: new Map(), byNameAndLine: new Map(), meta: { files: [], routes: 0 } };
		}

		const byStopId = new Map();
		const byNameAndLine = new Map();
		let routeCount = 0;

		for (const file of files) {
			const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
			const routes = Array.isArray(parsed.routes) ? parsed.routes : [];
			routeCount += routes.length;

			for (const route of routes) {
				for (const direction of route.directions || []) {
					for (const stop of direction.stops || []) {
						const stopId = String(stop.stop_id || "").trim();
						if (!stopId) continue;
						const entries = buildDepartureEntries({ route, direction, stop });
						const list = byStopId.get(stopId) || [];
						list.push(...entries);
						byStopId.set(stopId, list);
						const stopNameKey = normalizeStopName(stop.name);
						if (stopNameKey) {
							for (const entry of entries) {
								const key = `${stopNameKey}|${entry.line}`;
								const lineList = byNameAndLine.get(key) || [];
								lineList.push(entry);
								byNameAndLine.set(key, lineList);
							}
						}
					}
				}
			}
		}

		for (const [stopId, entries] of byStopId.entries()) {
			entries.sort((left, right) => {
				if (left.line !== right.line) return left.line.localeCompare(right.line, undefined, { numeric: true });
				if (left.dayType !== right.dayType) return left.dayType.localeCompare(right.dayType);
				return left.scheduleMinutes - right.scheduleMinutes;
			});
			byStopId.set(stopId, entries);
		}
		for (const [key, entries] of byNameAndLine.entries()) {
			entries.sort((left, right) => left.scheduleMinutes - right.scheduleMinutes);
			byNameAndLine.set(key, entries);
		}

		console.log(`[staticTimetable] loaded ${routeCount} routes from ${files.length} schedule parts`);
		return {
			byStopId,
			byNameAndLine,
			meta: { files, routes: routeCount },
		};
	})();

	return scheduleIndexPromise;
}

function uniqueDepartures(items) {
	const seen = new Set();
	return items.filter((item) => {
		const key = `${item.line}|${item.destination || ""}|${item.minutes}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

async function getScheduledStopDepartures({ stopIds = [], stopName = null, lines = [], line = null, limit = 6 } = {}) {
	const normalizedStopIds = [...new Set(stopIds.map((value) => String(value || "").trim()).filter(Boolean))];
	const normalizedLines = [...new Set(lines.map(normalizeLine).filter(Boolean))];
	if (!normalizedStopIds.length && !stopName) return [];

	const { byStopId, byNameAndLine } = await loadScheduleIndex();
	const { weekdayKey, minutesNow } = getBrusselsDateParts();
	const lineFilter = line ? normalizeLine(line) : null;
	const allowedLines = lineFilter ? new Set([lineFilter]) : new Set(normalizedLines);

	let entries = normalizedStopIds
		.flatMap((stopId) => byStopId.get(stopId) || []);

	// Some app stops use merged ids that differ from GTFS physical stop ids.
	// Keep stop-id matches, but also enrich by stop name + line to cover these variants.
	if (stopName && normalizedLines.length) {
		const stopNameKey = normalizeStopName(stopName);
		const nameMatches = normalizedLines.flatMap((currentLine) => byNameAndLine.get(`${stopNameKey}|${currentLine}`) || []);
		entries = [...entries, ...nameMatches];
	}

	const departures = entries
		.filter((entry) => entry.dayType === weekdayKey)
		.filter((entry) => !allowedLines.size || allowedLines.has(entry.line))
		.filter((entry) => !lineFilter || entry.line === lineFilter)
		.map((entry) => {
			const minutes = computeUpcomingMinutes(entry.scheduleMinutes, minutesNow);
			return minutes === null ? null : {
				line: entry.line,
				destination: entry.destination,
				minutes,
				source: "scheduled",
			};
		})
		.filter(Boolean)
		.sort((left, right) => left.minutes - right.minutes);

	return uniqueDepartures(departures).slice(0, limit);
}

/**
 * Retourne TOUS les horaires théoriques d'un arrêt STIB, groupés par
 * ligne+direction+dayType. Utilisé par le nouveau onglet "Horaires" dans
 * ArretDetailPage côté iOS (parité avec GareDetailPage SNCB qui a la même
 * mécanique).
 *
 * Forme renvoyée :
 *   [{ line: "81", destination: "MONTGOMERY", dayTypes: {
 *        weekday: ["05:38", "05:59", ...],
 *        saturday: [...],
 *        sunday: [...] }, ... }]
 */
async function getFullStopSchedule(stopId) {
	const id = String(stopId || "").trim();
	if (!id) return [];

	const { byStopId } = await loadScheduleIndex();
	const entries = byStopId.get(id) || [];
	if (!entries.length) return [];

	// Group: line + destination → { dayType → [HH:MM, ...] }
	const grouped = new Map();
	for (const entry of entries) {
		const key = `${entry.line}|${entry.destination || ""}`;
		if (!grouped.has(key)) {
			grouped.set(key, {
				line: entry.line,
				destination: entry.destination || null,
				dayTypes: {},
			});
		}
		const bundle = grouped.get(key);
		if (!bundle.dayTypes[entry.dayType]) bundle.dayTypes[entry.dayType] = [];
		// scheduleMinutes -> "HH:MM"
		const hh = String(Math.floor(entry.scheduleMinutes / 60)).padStart(2, "0");
		const mm = String(entry.scheduleMinutes % 60).padStart(2, "0");
		bundle.dayTypes[entry.dayType].push(`${hh}:${mm}`);
	}

	// Sort les départures de chaque dayType chronologiquement + dédup.
	for (const bundle of grouped.values()) {
		for (const dayType of Object.keys(bundle.dayTypes)) {
			bundle.dayTypes[dayType] = [...new Set(bundle.dayTypes[dayType])].sort();
		}
	}

	// Tri du résultat : ligne (numérique) puis destination.
	return [...grouped.values()].sort((a, b) => {
		const lineCmp = a.line.localeCompare(b.line, undefined, { numeric: true });
		if (lineCmp !== 0) return lineCmp;
		return (a.destination || "").localeCompare(b.destination || "");
	});
}

module.exports = {
	getScheduledStopDepartures,
	getFullStopSchedule,
};
