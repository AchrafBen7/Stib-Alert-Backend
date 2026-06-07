const venueEventsCatalog = require("../data/events-bruxelles.json");

const BRUSSELS_TIME_ZONE = "Europe/Brussels";
const UPCOMING_WINDOW_MINUTES = 6 * 60;
const PRE_EVENT_LEAD_MINUTES = 90;
const POST_EVENT_BUFFER_MINUTES = 60;
const DEFAULT_RADIUS_METERS = 550;
let normalizedCatalogEvents = null;

const VENUE_STOP_MAP = {
	"ing-arena": ["Heysel", "Roi Baudouin", "Palais 12"],
	"king-baudouin-stadium": ["Heysel", "Roi Baudouin", "Stade"],
	"lotto-park": ["Saint-Guidon", "Aumale"],
	"forest-national": ["Forest National", "Globe", "Albert"],
	"ancienne-belgique": ["De Brouckère", "Bourse", "Sainte-Catherine"],
	"bozar": ["Gare Centrale", "Parc", "Royale"],
	"cirque-royal": ["Madou", "Parc", "Congrès"],
};

function toDate(value) {
	if (!value) return null;
	const date = value instanceof Date ? value : new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeLine(line) {
	return String(line || "").trim();
}

function compactLine(line) {
	return normalizeLine(line).split(":")[0];
}

function compactStopName(raw) {
	return String(raw || "").replace(/\s+/g, " ").trim();
}

function uniqueStrings(values = []) {
	return [...new Set(values.filter(Boolean))];
}

function haversineMeters(aLat, aLng, bLat, bLng) {
	if (![aLat, aLng, bLat, bLng].every((value) => typeof value === "number" && Number.isFinite(value))) {
		return null;
	}
	const toRad = (value) => (value * Math.PI) / 180;
	const earthRadius = 6371e3;
	const dLat = toRad(bLat - aLat);
	const dLng = toRad(bLng - aLng);
	const lat1 = toRad(aLat);
	const lat2 = toRad(bLat);
	const sinLat = Math.sin(dLat / 2);
	const sinLng = Math.sin(dLng / 2);
	const a = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
	const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
	return earthRadius * c;
}

function impactWeight(level) {
	switch (String(level || "").toLowerCase()) {
	case "high":
		return 1;
	case "moderate":
		return 0.72;
	case "low":
		return 0.45;
	default:
		return 0.58;
	}
}

function estimateEndDate(startDate, category, attendance = 0) {
	const durationHours = (() => {
		const normalized = String(category || "").toLowerCase();
		if (normalized.includes("festival")) return 7;
		if (normalized.includes("match") || normalized.includes("sport")) return 4;
		if (normalized.includes("expo")) return 6;
		if (attendance >= 20000) return 5;
		if (attendance >= 8000) return 4;
		return 3;
	})();

	return new Date(startDate.getTime() + durationHours * 60 * 60 * 1000);
}

function deriveImpactLevel({ soldOut = false, expectedAttendance = 0, capacity = 0, category = "" }) {
	const attendance = Math.max(expectedAttendance || 0, 0);
	const normalized = String(category || "").toLowerCase();
	const occupancy = capacity > 0 ? attendance / capacity : 0;

	if (soldOut || attendance >= 18000 || occupancy >= 0.92 || normalized.includes("festival")) return "high";
	if (attendance >= 6000 || occupancy >= 0.62 || normalized.includes("concert") || normalized.includes("match")) return "moderate";
	return "low";
}

function deriveZoneLabel(venue = {}) {
	return String(venue.note || "")
		.split("—")[0]
		.replace(/\.$/, "")
		.trim() || venue.name || null;
}

function buildStartDate(date, time) {
	const safeDate = String(date || "").trim();
	if (!safeDate) return null;
	const safeTime = String(time || "19:00").trim() || "19:00";
	return toDate(`${safeDate}T${safeTime}:00+02:00`);
}

function normalizeCatalogEvents() {
	if (normalizedCatalogEvents) return normalizedCatalogEvents;
	const events = Array.isArray(venueEventsCatalog?.events) ? venueEventsCatalog.events : [];
	normalizedCatalogEvents = events
		.map((event) => {
			const venue = event.venue || {};
			const startsAt = buildStartDate(event.date, event.time);
			if (!startsAt) return null;
			const expectedAttendance = Number.isFinite(event.expectedAttendance) ? event.expectedAttendance : (venue.capacity || 0);
			const impactLevel = deriveImpactLevel({
				soldOut: event.soldOut,
				expectedAttendance,
				capacity: venue.capacity || 0,
				category: event.category,
			});
			return {
				id: event.id,
				source: "events-bruxelles",
				title: event.title,
				category: event.category || "event",
				venue: venue.name || event.venueId || null,
				zoneLabel: deriveZoneLabel(venue),
				address: venue.address || null,
				latitude: venue.lat ?? null,
				longitude: venue.lng ?? null,
				radiusMeters: venue.radiusMeters || DEFAULT_RADIUS_METERS,
				startsAt,
				endsAt: estimateEndDate(startsAt, event.category, expectedAttendance),
				expectedAttendance,
				impactLevel,
				impactedLines: Array.isArray(venue.primaryLines) ? venue.primaryLines : [],
				impactedStops: VENUE_STOP_MAP[event.venueId] || [],
				notesFr: venue.note || null,
				url: event.url || venue.url || null,
				soldOut: Boolean(event.soldOut),
			};
		})
		.filter(Boolean);
	return normalizedCatalogEvents;
}

function eventPhase(event, now = new Date()) {
	const nowDate = toDate(now) || new Date();
	const start = event.startsAt?.getTime?.();
	const end = event.endsAt?.getTime?.();
	if (!start || !end) return "unknown";
	if (nowDate.getTime() < start) return "upcoming";
	if (nowDate.getTime() <= end) return "live";
	return "ended";
}

function levelFromScore(score) {
	if (score >= 0.82) return "high";
	if (score >= 0.56) return "moderate";
	if (score >= 0.28) return "low";
	return "none";
}

function levelLabel(level, lang = "fr") {
	const nl = lang === "nl";
	switch (level) {
	case "high":
		return nl ? "Hoge drukte waarschijnlijk" : "Affluence élevée probable";
	case "moderate":
		return nl ? "Verhoogde drukte waarschijnlijk" : "Affluence renforcée probable";
	case "low":
		return nl ? "Drukte mogelijk" : "Affluence possible";
	default:
		return nl ? "Stabiele drukte" : "Affluence stable";
	}
}

function activeOrUpcomingEvents(now = new Date()) {
	const nowDate = toDate(now) || new Date();
	return normalizeCatalogEvents()
		.map((event) => ({
			...event,
			startsAt: toDate(event.startsAt),
			endsAt: toDate(event.endsAt),
		}))
		.filter((event) => event.startsAt && event.endsAt)
		.filter((event) => {
			const startWindow = event.startsAt.getTime() - PRE_EVENT_LEAD_MINUTES * 60 * 1000;
			const endWindow = event.endsAt.getTime() + POST_EVENT_BUFFER_MINUTES * 60 * 1000;
			return nowDate.getTime() >= startWindow && nowDate.getTime() <= endWindow;
		});
}

function timeScore(event, now = new Date()) {
	const nowDate = toDate(now) || new Date();
	const start = event.startsAt?.getTime?.();
	const end = event.endsAt?.getTime?.();
	if (!start || !end) return 0;

	if (nowDate.getTime() >= start && nowDate.getTime() <= end) return 1;
	if (nowDate.getTime() < start) {
		const diffMinutes = (start - nowDate.getTime()) / 60000;
		if (diffMinutes > UPCOMING_WINDOW_MINUTES) return 0;
		return Math.max(0.25, 1 - diffMinutes / UPCOMING_WINDOW_MINUTES);
	}

	const elapsedMinutes = (nowDate.getTime() - end) / 60000;
	if (elapsedMinutes > POST_EVENT_BUFFER_MINUTES) return 0;
	return Math.max(0.2, 1 - elapsedMinutes / POST_EVENT_BUFFER_MINUTES);
}

function proximityScore({ event, lat, lng, stops = [] }) {
	const userDistance = haversineMeters(lat, lng, event.latitude, event.longitude);
	const stopDistances = stops
		.map((stop) => haversineMeters(stop.latitude, stop.longitude, event.latitude, event.longitude))
		.filter((value) => value !== null);
	const nearestDistance = [userDistance, ...stopDistances]
		.filter((value) => value !== null)
		.sort((a, b) => a - b)[0];

	if (nearestDistance === undefined) return 0.18;
	const venueRadius = Number.isFinite(event.radiusMeters) ? event.radiusMeters : DEFAULT_RADIUS_METERS;
	if (nearestDistance <= Math.min(300, venueRadius)) return 1;
	if (nearestDistance <= venueRadius) return 0.9;
	if (nearestDistance <= venueRadius + 400) return 0.76;
	if (nearestDistance <= venueRadius + 900) return 0.58;
	if (nearestDistance <= 2000) return 0.45;
	if (nearestDistance <= 3000) return 0.24;
	return 0.08;
}

function lineOverlapScore({ event, lines = [] }) {
	const normalizedInput = uniqueStrings(lines.map(compactLine));
	const impactedLines = uniqueStrings((event.impactedLines || []).map(compactLine));
	if (!normalizedInput.length || !impactedLines.length) return 0;
	const overlap = impactedLines.filter((line) => normalizedInput.includes(line));
	if (!overlap.length) return 0;
	return Math.min(1, 0.5 + overlap.length * 0.2);
}

function stopMatchScore({ event, stopNames = [] }) {
	const normalizedStops = uniqueStrings(stopNames.map((name) => compactStopName(name).toLowerCase()));
	const impactedStops = uniqueStrings((event.impactedStops || []).map((name) => compactStopName(name).toLowerCase()));
	if (!normalizedStops.length || !impactedStops.length) return 0;
	return impactedStops.some((stop) => normalizedStops.includes(stop)) ? 0.85 : 0;
}

function buildEventNarrative(event, level, lang = "fr") {
	const nl = lang === "nl";
	const startText = new Intl.DateTimeFormat(nl ? "nl-BE" : "fr-BE", {
		hour: "2-digit",
		minute: "2-digit",
		timeZone: BRUSSELS_TIME_ZONE,
	}).format(event.startsAt);
	const zone = event.zoneLabel || event.venue;

	switch (level) {
	case "high":
		return nl
			? `${event.title} rond ${zone}: hoge drukte waarschijnlijk vanaf ${startText}.`
			: `${event.title} autour de ${zone}: affluence forte probable dès ${startText}.`;
	case "moderate":
		return nl
			? `${event.title} rond ${zone}: verhoogde drukte waarschijnlijk vanaf ${startText}.`
			: `${event.title} autour de ${zone}: affluence renforcée probable dès ${startText}.`;
	default:
		return nl
			? `${event.title} rond ${zone}: hou de drukte in de gaten vanaf ${startText}.`
			: `${event.title} autour de ${zone}: surveiller la charge à partir de ${startText}.`;
	}
}

function buildCrowdingRisk({
	now = new Date(),
	lat = null,
	lng = null,
	lineId = null,
	lines = [],
	stop = null,
	stops = [],
	stopNames = [],
}) {
	const linePool = uniqueStrings([
		...lines.map(compactLine),
		compactLine(lineId),
		...(stop?.lines || []).map(compactLine),
		...stops.flatMap((item) => item.lines || []).map(compactLine),
	]);
	const stopPool = uniqueStrings([
		compactStopName(stop?.name),
		...stopNames.map(compactStopName),
		...stops.map((item) => compactStopName(item.name)),
	]);

	const scoredEvents = activeOrUpcomingEvents(now)
		.map((event) => {
			const score = (
				timeScore(event, now) * 0.38
				+ proximityScore({ event, lat, lng, stops: [stop, ...stops].filter(Boolean) }) * 0.22
				+ lineOverlapScore({ event, lines: linePool }) * 0.24
				+ stopMatchScore({ event, stopNames: stopPool }) * 0.16
			) * impactWeight(event.impactLevel);

			return {
				...event,
				score,
				level: levelFromScore(score),
			};
		})
		.filter((event) => event.score >= 0.28)
		.sort((a, b) => b.score - a.score);

	if (!scoredEvents.length) return null;

	const strongest = scoredEvents[0];
	const level = strongest.level;
	const impactedLines = uniqueStrings(scoredEvents.flatMap((event) => event.impactedLines || []).map(compactLine)).slice(0, 6);
	const impactedStops = uniqueStrings(scoredEvents.flatMap((event) => event.impactedStops || []).map(compactStopName)).slice(0, 6);
	const eventNames = uniqueStrings(scoredEvents.map((event) => event.title)).slice(0, 3);
	const longText = buildEventNarrative(strongest, level, "fr");
	const longTextNl = buildEventNarrative(strongest, level, "nl");

	return {
		level,
		title: levelLabel(level, "fr"),
		titleNl: levelLabel(level, "nl"),
		shortText: longText,
		shortTextNl: longTextNl,
		longText,
		longTextNl,
		eventNames,
		zoneLabel: strongest.zoneLabel || strongest.venue || null,
		impactedLines,
		impactedStops,
		confidence: Number(strongest.score.toFixed(2)),
		source: "events-bruxelles",
	};
}

function listEventImpacts({
	now = new Date(),
	line = null,
	query = null,
	activeOnly = false,
	limit = 60,
} = {}) {
	const normalizedLine = compactLine(line);
	const normalizedQuery = String(query || "").trim().toLowerCase();

	return normalizeCatalogEvents()
		.map((event) => {
			const phase = eventPhase(event, now);
			const confidence = Number(
				(
					timeScore(event, now) * 0.45
					+ impactWeight(event.impactLevel) * 0.35
					+ (event.soldOut ? 0.2 : 0.08)
				).toFixed(2)
			);

			return {
				...event,
				phase,
				confidence,
				titleLabel: phase === "live" ? "En cours" : phase === "upcoming" ? "À venir" : "Terminé",
			};
		})
		.filter((event) => !activeOnly || event.phase === "live" || event.phase === "upcoming")
		.filter((event) => {
			if (!normalizedLine) return true;
			return (event.impactedLines || []).map(compactLine).includes(normalizedLine);
		})
		.filter((event) => {
			if (!normalizedQuery) return true;
			return [
				event.title,
				event.venue,
				event.zoneLabel,
				event.address,
				...(event.impactedStops || []),
				...(event.impactedLines || []),
			]
				.filter(Boolean)
				.some((value) => String(value).toLowerCase().includes(normalizedQuery));
		})
		.sort((a, b) => {
			const aPhase = a.phase === "live" ? 0 : a.phase === "upcoming" ? 1 : 2;
			const bPhase = b.phase === "live" ? 0 : b.phase === "upcoming" ? 1 : 2;
			if (aPhase !== bPhase) return aPhase - bPhase;
			if (a.phase === "ended" && b.phase === "ended") {
				return b.startsAt.getTime() - a.startsAt.getTime();
			}
			return a.startsAt.getTime() - b.startsAt.getTime();
		})
		.slice(0, limit)
		.map((event) => ({
			id: event.id,
			source: event.source,
			title: event.title,
			category: event.category,
			venue: event.venue,
			zoneLabel: event.zoneLabel,
			address: event.address,
			latitude: event.latitude ?? null,
			longitude: event.longitude ?? null,
			startsAt: event.startsAt,
			endsAt: event.endsAt,
			phase: event.phase,
			phaseLabel: event.titleLabel,
			expectedAttendance: event.expectedAttendance || null,
			impactLevel: event.impactLevel,
			notesFr: event.notesFr || null,
			impactedLines: event.impactedLines || [],
			impactedStops: event.impactedStops || [],
			confidence: event.confidence,
			soldOut: Boolean(event.soldOut),
			url: event.url || null,
		}));
}

module.exports = {
	buildCrowdingRisk,
	listEventImpacts,
};
