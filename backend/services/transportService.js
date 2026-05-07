const mongoose = require("mongoose");
const Arret = require("../models/Arret");
const Ligne = require("../models/Ligne");
const Signalement = require("../models/Signalement");
const { getTravellersInformation, getWaitingTimes, getVehiclePositions, getShapeFiles } = require("./belgianMobility");
const {
	fetchItinerairesGoogle,
	fetchItinerairesGoogleWalk,
	fetchItinerairesGoogleBike,
} = require("./googleDirections");
const cache = require("./memoryCache");
const { buildCommunityMeta } = require("./signalementCommunityService");
const { scoreRoutes } = require("./routeScoringService");
const { getFragilitySnapshots } = require("./stopFragilityService");
const {
	SEVERITY,
	formatSeverity,
	severityFromSignalement,
	summarizeSeverity,
} = require("./transportSeverity");
const { buildPerturbationSummary } = require("./perturbationSummaryService");
const { buildCrowdingRisk } = require("./eventCrowdingService");
const { getScheduledStopDepartures } = require("./staticTimetableService");
const { getStaticShapeFilesForLines } = require("./staticShapeService");

const TTL = {
	waitingTimes: 20_000,
	vehiclePositions: 15_000,
	travellersInformation: 45_000,
	shapeFiles: 6 * 60 * 60 * 1000,
	stopOverview: 20_000,
	lineOverview: 20_000,
	routeRecommend: 90_000,
};

const OFFICIAL_STATUS = {
	AVAILABLE: "available",
	LIMITED: "limited",
	UNAVAILABLE: "unavailable",
};

function stableKey(prefix, payload) {
	return `${prefix}:${JSON.stringify(payload)}`;
}

function roundedCoordinate(value) {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	return Number(value.toFixed(3));
}

function roundedCoordinateString(value) {
	if (typeof value !== "string") return null;
	const [latRaw, lngRaw] = value.split(",").map((item) => Number.parseFloat(item.trim()));
	const lat = roundedCoordinate(latRaw);
	const lng = roundedCoordinate(lngRaw);
	if (lat === null || lng === null) return null;
	return `${lat},${lng}`;
}

function normalizeLine(line) {
	const normalized = String(line || "").trim().toUpperCase();
	return /^T\d+$/.test(normalized) ? normalized.slice(1) : normalized;
}

function lineCandidates(lineId) {
	const normalized = normalizeLine(lineId);
	if (!normalized) return [];
	const base = normalized.split(":")[0];
	return [...new Set([normalized, base])];
}

function toMinutes(value) {
	if (typeof value === "number" && Number.isFinite(value)) return Math.max(Math.round(value), 0);
	if (typeof value !== "string") return null;
	if (/^(due|now)$/i.test(value.trim())) return 0;
	const match = value.match(/(\d+)/);
	return match ? Math.max(Number.parseInt(match[1], 10), 0) : null;
}

function normalizeText(value) {
	return String(value || "")
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/\s+/g, " ")
		.trim();
}

function parseDateValue(value) {
	if (!value) return null;
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function addMinutes(date, minutes) {
	if (!(date instanceof Date) || Number.isNaN(date.getTime()) || !Number.isFinite(minutes)) return null;
	return new Date(date.getTime() + minutes * 60_000);
}

function distanceMetersBetween(a, b) {
	if (!a || !b) return Number.POSITIVE_INFINITY;
	if (![a.lat, a.lng, b.lat, b.lng].every((value) => Number.isFinite(value))) return Number.POSITIVE_INFINITY;
	const earthRadius = 6371000;
	const toRadians = (value) => (value * Math.PI) / 180;
	const dLat = toRadians(b.lat - a.lat);
	const dLng = toRadians(b.lng - a.lng);
	const lat1 = toRadians(a.lat);
	const lat2 = toRadians(b.lat);
	const sinLat = Math.sin(dLat / 2);
	const sinLng = Math.sin(dLng / 2);
	const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
	return 2 * earthRadius * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function buildWaitingTimeIndex(waitingItems = []) {
	const byLine = new Map();

	for (const item of waitingItems) {
		const line = normalizeLine(item.line);
		if (!line) continue;
		const list = byLine.get(line) || [];
		list.push(item);
		byLine.set(line, list);
	}

	for (const list of byLine.values()) {
		list.sort((left, right) => {
			const leftMinutes = toMinutes(left.minutes);
			const rightMinutes = toMinutes(right.minutes);
			return (leftMinutes ?? Number.POSITIVE_INFINITY) - (rightMinutes ?? Number.POSITIVE_INFINITY);
		});
	}

	return byLine;
}

function selectRealtimeDeparture(step, waitingIndex) {
	const candidates = waitingIndex.get(normalizeLine(step.line)) || [];
	if (!candidates.length) return null;

	const normalizedStopName = normalizeText(step.stopName);
	const normalizedDestination = normalizeText(step.destination);
	const ranked = candidates
		.map((candidate) => {
			let score = 0;
			if (normalizedStopName && normalizeText(candidate.stopName) === normalizedStopName) score += 6;
			if (normalizedDestination && normalizeText(candidate.destination) === normalizedDestination) score += 4;
			if (normalizedDestination && normalizeText(candidate.destination).includes(normalizedDestination)) score += 2;
			const minutes = toMinutes(candidate.minutes);
			if (minutes !== null) score += Math.max(30 - minutes, 0) * 0.01;
			return { candidate, score, minutes };
		})
		.filter((entry) => entry.minutes !== null)
		.sort((left, right) => right.score - left.score || left.minutes - right.minutes);

	return ranked[0]?.candidate || null;
}

function selectRelevantAlerts(step, officialItems = []) {
	const line = normalizeLine(step.line);
	const stopName = normalizeText(step.stopName);
	const arrivalStopName = normalizeText(step.arrivalStopName);

	return officialItems
		.filter((item) => {
			const matchesLine = !line || (item.lines || []).some((value) => normalizeLine(value) === line);
			if (!matchesLine) return false;
			if (!stopName && !arrivalStopName) return true;
			const stopTokens = (item.stops || []).map(normalizeText).filter(Boolean);
			return stopTokens.some((value) => value === stopName || value === arrivalStopName);
		})
		.slice(0, 3)
		.map((item) => ({
			id: item.id,
			title: item.title || "Information STIB",
			description: item.description || null,
			priority: item.priority || null,
			lines: item.lines || [],
			stops: item.stops || [],
		}));
}

function selectActiveVehicle(step, vehicles = []) {
	const line = normalizeLine(step.line);
	if (!line) return null;

	const origin = Number.isFinite(step.startLatitude) && Number.isFinite(step.startLongitude)
		? { lat: step.startLatitude, lng: step.startLongitude }
		: null;
	const destination = Number.isFinite(step.targetLatitude) && Number.isFinite(step.targetLongitude)
		? { lat: step.targetLatitude, lng: step.targetLongitude }
		: null;

	const ranked = vehicles
		.filter((vehicle) => normalizeLine(vehicle.line) === line)
		.map((vehicle) => {
			const vehiclePoint = Number.isFinite(vehicle.latitude) && Number.isFinite(vehicle.longitude)
				? { lat: vehicle.latitude, lng: vehicle.longitude }
				: null;
			const originDistance = distanceMetersBetween(vehiclePoint, origin);
			const destinationDistance = distanceMetersBetween(vehiclePoint, destination);
			const directionScore = normalizeText(vehicle.direction) && normalizeText(step.destination)
				? (normalizeText(vehicle.direction).includes(normalizeText(step.destination)) ? 0 : 2500)
				: 0;
			return {
				vehicle,
				score: Math.min(originDistance, destinationDistance) + directionScore,
			};
		})
		.sort((left, right) => left.score - right.score);

	return ranked[0]?.vehicle || null;
}

function enrichAlternativeRealtime(alternative, { waitingItems = [], vehicleItems = [], officialItems = [], requestDate = new Date() }) {
	const waitingIndex = buildWaitingTimeIndex(waitingItems);
	const steps = (alternative.steps || []).map((step) => {
		if (!step.line) {
			return {
				...step,
				alerts: step.alerts || [],
			};
		}

		const realtimeDeparture = selectRealtimeDeparture(step, waitingIndex);
		const realtimeDepartureMinutes = realtimeDeparture ? toMinutes(realtimeDeparture.minutes) : null;
		const realtimeDepartureAt = realtimeDepartureMinutes !== null ? addMinutes(requestDate, realtimeDepartureMinutes) : null;
		const realtimeArrivalAt = realtimeDepartureAt ? addMinutes(realtimeDepartureAt, step.durationMinutes) : null;
		const alerts = selectRelevantAlerts(step, officialItems);
		const vehicle = selectActiveVehicle(step, vehicleItems);

		return {
			...step,
			realtimeDepartureMinutes,
			realtimeDepartureAt,
			realtimeArrivalAt,
			vehicle: vehicle ? {
				vehicleId: vehicle.vehicleId || null,
				line: vehicle.line || null,
				direction: vehicle.direction || null,
				latitude: vehicle.latitude ?? null,
				longitude: vehicle.longitude ?? null,
				updatedAt: vehicle.updatedAt || null,
			} : null,
			alerts,
		};
	});

	const firstScheduledDeparture = steps
		.map((step) => parseDateValue(step.scheduledDepartureAt))
		.find(Boolean) || null;
	const firstRealtimeDeparture = steps
		.map((step) => parseDateValue(step.realtimeDepartureAt))
		.find(Boolean) || null;
	const lastScheduledArrival = [...steps]
		.reverse()
		.map((step) => parseDateValue(step.scheduledArrivalAt))
		.find(Boolean) || null;
	const lastRealtimeArrival = [...steps]
		.reverse()
		.map((step) => parseDateValue(step.realtimeArrivalAt))
		.find(Boolean) || null;
	const routeAlerts = steps.flatMap((step) => step.alerts || []);

	return {
		...alternative,
		steps,
		scheduledDepartureAt: firstScheduledDeparture,
		scheduledArrivalAt: lastScheduledArrival,
		realtimeDepartureAt: firstRealtimeDeparture,
		realtimeArrivalAt: lastRealtimeArrival,
		activeVehicle: steps.map((step) => step.vehicle).find(Boolean) || null,
		officialAlerts: routeAlerts.filter((item, index, items) => items.findIndex((candidate) => candidate.id === item.id) === index).slice(0, 4),
	};
}

function extractTransitLines(route) {
	return route.legs.flatMap((leg) =>
		leg.steps
			.filter((step) => step.travel_mode === "TRANSIT")
			.map((step) => normalizeLine(step.transit_details?.line?.short_name))
			.filter(Boolean)
	);
}

function collectTransitStops(route) {
	return route.legs.flatMap((leg) =>
		leg.steps
			.filter((step) => step.travel_mode === "TRANSIT")
			.flatMap((step) => [
				step.transit_details?.departure_stop?.name,
				step.transit_details?.arrival_stop?.name,
			])
			.filter(Boolean)
	);
}

function lineMode(lineId) {
	const numeric = Number.parseInt(String(lineId), 10);
	if (["1", "2", "5", "6"].includes(String(lineId))) return "metro";
	if (!Number.isNaN(numeric) && numeric >= 90) return "bus";
	return "tram";
}

async function getCachedTravellersInformation(query) {
	return cache.remember(
		stableKey("travellers-information", query),
		TTL.travellersInformation,
		async () => getTravellersInformation(query)
	);
}

async function getCachedWaitingTimes(query) {
	return cache.remember(
		stableKey("waiting-times", query),
		TTL.waitingTimes,
		async () => getWaitingTimes(query)
	);
}

async function getCachedVehiclePositions(query) {
	return cache.remember(
		stableKey("vehicle-positions", query),
		TTL.vehiclePositions,
		async () => getVehiclePositions(query)
	);
}

async function getCachedShapeFiles(query) {
	return cache.remember(
		stableKey("shape-files", query),
		TTL.shapeFiles,
		async () => getShapeFiles(query)
	);
}

async function getCachedDatasetWithStatus({ keyPrefix, query, ttlMs, loader, emptyValue }) {
	const key = stableKey(keyPrefix, query);
	const fresh = cache.get(key);
	if (fresh?.value !== undefined) {
		return {
			data: fresh.value,
			officialDataStatus: OFFICIAL_STATUS.AVAILABLE,
			officialDataMessage: null,
		};
	}

	const stale = cache.get(key, { allowStale: true });

	try {
		const value = await loader(query);
		cache.set(key, value, ttlMs);
		return {
			data: value,
			officialDataStatus: OFFICIAL_STATUS.AVAILABLE,
			officialDataMessage: null,
		};
	} catch (error) {
		if (stale?.value !== undefined) {
			return {
				data: stale.value,
				officialDataStatus: OFFICIAL_STATUS.LIMITED,
				officialDataMessage: "Les donnees officielles STIB sont temporairement limitees. Affichage du dernier etat connu.",
			};
		}

		return {
			data: emptyValue,
			officialDataStatus: OFFICIAL_STATUS.UNAVAILABLE,
			officialDataMessage: "Les donnees officielles STIB sont temporairement indisponibles. Les informations communautaires restent actives.",
			error,
		};
	}
}

async function getTravellersInformationWithStatus(query) {
	return getCachedDatasetWithStatus({
		keyPrefix: "travellers-information",
		query,
		ttlMs: TTL.travellersInformation,
		loader: getTravellersInformation,
		emptyValue: { payload: null, items: [] },
	});
}

async function getWaitingTimesWithStatus(query) {
	return getCachedDatasetWithStatus({
		keyPrefix: "waiting-times",
		query,
		ttlMs: TTL.waitingTimes,
		loader: getWaitingTimes,
		emptyValue: { payload: null, items: [] },
	});
}

async function getVehiclePositionsWithStatus(query) {
	return getCachedDatasetWithStatus({
		keyPrefix: "vehicle-positions",
		query,
		ttlMs: TTL.vehiclePositions,
		loader: getVehiclePositions,
		emptyValue: { payload: null, items: [] },
	});
}

async function getShapeFilesWithStatus(query) {
	return getCachedDatasetWithStatus({
		keyPrefix: "shape-files",
		query,
		ttlMs: TTL.shapeFiles,
		loader: getShapeFiles,
		emptyValue: { payload: null, items: [] },
	});
}

function mergeOfficialStatuses(statuses = []) {
	const normalized = statuses.filter(Boolean);
	if (normalized.includes(OFFICIAL_STATUS.UNAVAILABLE)) return OFFICIAL_STATUS.UNAVAILABLE;
	if (normalized.includes(OFFICIAL_STATUS.LIMITED)) return OFFICIAL_STATUS.LIMITED;
	return OFFICIAL_STATUS.AVAILABLE;
}

function firstOfficialMessage(messages = []) {
	return messages.find(Boolean) || null;
}

function buildScheduledFallbackMessage(currentMessage) {
	const fallbackMessage = "Temps reel STIB indisponible. Horaires theoriques affiches depuis la base statique.";
	if (!currentMessage) return fallbackMessage;
	if (String(currentMessage).includes("Horaires theoriques")) return currentMessage;
	return `${currentMessage} ${fallbackMessage}`;
}

function getStaleCachedValue(key) {
	return cache.get(key, { allowStale: true })?.value || null;
}

function hasTransitAlternatives(recommendation) {
	return Array.isArray(recommendation?.recommendedAlternatives)
		&& recommendation.recommendedAlternatives.some((alternative) => Array.isArray(alternative.lines) && alternative.lines.length > 0);
}

function buildDegradedRouteResponse({
	depart,
	destination,
	lignesBloquees,
	officialDataStatus,
	officialDataMessage,
	message,
}) {
	return {
		request: { depart, destination, lignesBloquees },
		severity: SEVERITY.MINOR,
		confidence: 0.55,
		realtimeStatus: "fallback",
		officialDataStatus,
		officialDataMessage,
		activeIncidents: [],
		nextDepartures: [],
		recommendedAlternatives: [],
		fallback: {
			reason: "directions_unavailable",
			message,
		},
	};
}

function buildStaleRouteRecommendation({
	staleRecommendation,
	officialDataStatus,
	officialDataMessage,
	message,
}) {
	return {
		...staleRecommendation,
		realtimeStatus: staleRecommendation?.realtimeStatus === "stable" ? "limited" : (staleRecommendation?.realtimeStatus || "limited"),
		officialDataStatus: mergeOfficialStatuses([
			staleRecommendation?.officialDataStatus,
			officialDataStatus,
		]),
		officialDataMessage: officialDataMessage || staleRecommendation?.officialDataMessage || null,
		fallback: {
			reason: "stale_route_reused",
			message,
		},
	};
}

async function getCachedDirections(query) {
	return cache.remember(
		stableKey("google-directions", query),
		TTL.routeRecommend,
		async () => {
			switch (query.mode) {
			case "walking":
				return fetchItinerairesGoogleWalk(query.depart, query.destination);
			case "bicycling":
				return fetchItinerairesGoogleBike(query.depart, query.destination);
			default:
				return fetchItinerairesGoogle(query.depart, query.destination);
			}
		}
	);
}

async function getRecentSignalements({ line, stopIds = [], limit = 100 } = {}) {
	const since = new Date(Date.now() - 2 * 60 * 60 * 1000);
	const query = {
		dateSignalement: { $gte: since },
		status: { $ne: "resolved" },
		moderationStatus: "approved",
	};

	if (line) query.ligne = line;
	if (stopIds.length) query.arretId = { $in: stopIds };

	return Signalement.find(query)
		.sort({ dateSignalement: -1 })
		.limit(limit)
		.populate("arretId")
		.lean();
}

async function getStopsByRealtimeIds(stopIds = []) {
	const ids = [...new Set(stopIds.map((value) => String(value || "").trim()).filter(Boolean))];
	if (!ids.length) return new Map();

	const cacheKey = stableKey("transport-stops-by-realtime-ids", ids.sort());
	const stops = await cache.remember(cacheKey, TTL.stopOverview, async () => {
		return Arret.find({
			$or: [
				{ stop_id: { $in: ids } },
				{ merged_stop_id: { $in: ids } },
				{ physicalStopIds: { $in: ids } },
			],
		}).lean();
	});

	const index = new Map();
	for (const stop of stops) {
		for (const key of [stop.stop_id, stop.merged_stop_id, ...(stop.physicalStopIds || [])]) {
			if (key) index.set(String(key), stop);
		}
	}
	return index;
}

function mapIncident(signalement) {
	const community = buildCommunityMeta(signalement);
	const severity = community.status === "resolved"
		? SEVERITY.MINOR
		: severityFromSignalement(signalement);
	return {
		id: signalement._id,
		type: signalement.typeProbleme,
		description: signalement.description,
		severity,
		confidence: community.confidence,
		legacyConfidence: signalement.confiance || null,
		source: "community",
		line: signalement.ligne,
		stop: signalement.arretId && typeof signalement.arretId === "object"
			? {
				id: signalement.arretId._id,
				name: signalement.arretId.nom,
				latitude: signalement.arretId.latitude ?? null,
				longitude: signalement.arretId.longitude ?? null,
			}
			: null,
		date: signalement.dateSignalement,
		latitude: signalement.latitude ?? null,
		longitude: signalement.longitude ?? null,
		community,
	};
}

function signalementStopPayload(signalement) {
	if (!signalement?.arretId || typeof signalement.arretId !== "object") return null;
	return {
		id: signalement.arretId._id,
		name: signalement.arretId.nom,
		latitude: signalement.arretId.latitude ?? null,
		longitude: signalement.arretId.longitude ?? null,
	};
}

function signalementStopKey(signalement) {
	if (!signalement?.arretId) return "unknown-stop";
	if (typeof signalement.arretId === "object") {
		return String(signalement.arretId._id || signalement.arretId.stop_id || signalement.arretId.merged_stop_id || "unknown-stop");
	}
	return String(signalement.arretId);
}

function buildCommunityReportClusters(signalements = [], { threshold = 3 } = {}) {
	const groups = new Map();

	for (const signalement of signalements) {
		const line = normalizeLine(signalement.ligne);
		if (!line) continue;

		const stopKey = signalementStopKey(signalement);
		const key = `${line}:${stopKey}`;
		const group = groups.get(key) || {
			line,
			stopKey,
			stop: signalementStopPayload(signalement),
			items: [],
		};

		if (!group.stop) group.stop = signalementStopPayload(signalement);
		group.items.push(signalement);
		groups.set(key, group);
	}

	return [...groups.values()]
		.filter((group) => group.items.length >= threshold)
		.map((group) => {
			const sortedItems = group.items
				.slice()
				.sort((left, right) => new Date(right.dateSignalement || 0) - new Date(left.dateSignalement || 0));
			const count = sortedItems.length;
			const latestDate = sortedItems[0]?.dateSignalement || new Date();
			const severity = count >= 5 ? SEVERITY.MAJOR : SEVERITY.MINOR;
			const confidence = Math.min(0.95, 0.55 + count * 0.08);
			const freshnessMinutes = Math.max(0, Math.round((Date.now() - new Date(latestDate).getTime()) / 60_000));
			const stopName = group.stop?.name;

			return {
				id: `community-cluster:${group.line}:${group.stopKey}:${new Date(latestDate).getTime()}`,
				type: "Signalements nombreux",
				description: stopName
					? `Grand nombre de signalements pour la ligne ${group.line} à ${stopName} (${count} signalements récents).`
					: `Grand nombre de signalements pour la ligne ${group.line} (${count} signalements récents).`,
				severity,
				confidence,
				source: "community",
				line: group.line,
				stop: group.stop,
				date: latestDate,
				latitude: group.stop?.latitude ?? null,
				longitude: group.stop?.longitude ?? null,
				community: {
					status: "confirmed",
					confirmations: count,
					confidence,
					freshnessMinutes,
					clustered: true,
					threshold,
				},
			};
		});
}

function mapOfficialIncident(item, { defaultLine = null, stopLookup = new Map() } = {}) {
	const primaryLine = Array.isArray(item.lines) ? item.lines[0] : item.lines || defaultLine || null;
	const matchedStop = (item.stops || [])
		.map((stopId) => stopLookup.get(String(stopId)))
		.find(Boolean) || null;

	return {
		id: item.id != null ? String(item.id) : `official-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
		type: item.title || "Information STIB",
		description: item.description,
		severity: SEVERITY.MAJOR,
		confidence: 0.85,
		source: "official",
		line: normalizeLine(primaryLine),
		stop: matchedStop ? {
			id: matchedStop._id,
			stopId: matchedStop.stop_id || matchedStop.merged_stop_id || null,
			name: matchedStop.nom,
			latitude: matchedStop.latitude ?? null,
			longitude: matchedStop.longitude ?? null,
		} : null,
		date: item.updatedAt || null,
	};
}

function summarizeDepartures(waitingItems = [], lineFilter = null) {
	const departures = waitingItems
		.filter((item) => !lineFilter || normalizeLine(item.line) === normalizeLine(lineFilter))
		.map((item) => ({
			line: normalizeLine(item.line),
			destination: item.destination || null,
			minutes: toMinutes(item.minutes),
			source: "realtime",
		}))
		.filter((item) => item.line && item.minutes !== null)
		.sort((a, b) => a.minutes - b.minutes);

	return departures.slice(0, 6);
}

function filterDeparturesForStopLines(departures = [], lines = []) {
	const allowedLines = new Set((lines || []).map(normalizeLine).filter(Boolean));
	if (!allowedLines.size) return departures;
	return departures.filter((departure) => allowedLines.has(normalizeLine(departure.line)));
}

function sortLineIds(lines = []) {
	return [...lines].sort((left, right) => {
		const leftNumber = Number.parseInt(left, 10);
		const rightNumber = Number.parseInt(right, 10);
		if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber - rightNumber;
		return String(left).localeCompare(String(right), "fr", { numeric: true, sensitivity: "base" });
	});
}

function mergeStopLines(...lineGroups) {
	const merged = new Map();
	lineGroups.flat().forEach((line) => {
		const normalized = normalizeLine(line);
		if (!normalized || merged.has(normalized)) return;
		merged.set(normalized, normalized);
	});
	return sortLineIds(merged.values());
}

async function enrichDeparturesWithDelay(realtimeDepartures, stopIds, stopName, lines) {
	if (!realtimeDepartures.length) return realtimeDepartures;

	const scheduled = await getScheduledStopDepartures({
		stopIds,
		stopName,
		lines,
		limit: 12,
	});

	if (!scheduled.length) return realtimeDepartures;

	const now = Date.now();
	return realtimeDepartures.map((dep) => {
		const sameLine = scheduled.filter((s) => normalizeLine(s.line) === dep.line);
		if (!sameLine.length) return dep;

		const match = sameLine.reduce((best, item) => {
			if (!best) return item;
			return Math.abs(item.minutes - dep.minutes) < Math.abs(best.minutes - dep.minutes) ? item : best;
		}, null);

		if (!match || Math.abs(match.minutes - dep.minutes) > 20) return dep;

		return {
			...dep,
			delayMinutes: dep.minutes - match.minutes,
			scheduledDepartureAt: new Date(now + match.minutes * 60_000).toISOString(),
			realtimeDepartureAt: new Date(now + dep.minutes * 60_000).toISOString(),
		};
	});
}

async function getScheduledRouteDepartures(alternatives = [], limit = 6) {
	const candidates = [];
	const seen = new Set();

	for (const alternative of alternatives) {
		for (const step of alternative.steps || []) {
			if (!step.line || !step.stopName) continue;
			const key = `${normalizeLine(step.line)}|${String(step.stopName).toLowerCase()}`;
			if (seen.has(key)) continue;
			seen.add(key);
			candidates.push({ line: step.line, stopName: step.stopName });
			if (candidates.length >= 8) break;
		}
		if (candidates.length >= 8) break;
	}

	const scheduledGroups = await Promise.all(candidates.map((candidate) =>
		getScheduledStopDepartures({
			stopName: candidate.stopName,
			lines: [candidate.line],
			line: candidate.line,
			limit: 2,
		})
	));

	return scheduledGroups
		.flat()
		.sort((left, right) => left.minutes - right.minutes)
		.slice(0, limit);
}

function computeRealtimeStatus({ incidents, departures }) {
	if (!departures.length && incidents.some((incident) => incident.severity === SEVERITY.CRITICAL)) {
		return formatSeverity(SEVERITY.CRITICAL, 0.9);
	}
	if (!departures.length && incidents.length) {
		return formatSeverity(SEVERITY.MAJOR, 0.75);
	}
	if (!departures.length) {
		return formatSeverity(SEVERITY.MINOR, 0.6);
	}
	return summarizeSeverity(incidents);
}

async function getTransportStop(stopId) {
	return cache.remember(stableKey("transport-stop", { stopId }), TTL.stopOverview, async () => {
		const stopLookup = [{ merged_stop_id: String(stopId) }, { stop_id: String(stopId) }];
		if (mongoose.isValidObjectId(stopId)) {
			stopLookup.unshift({ _id: stopId });
		}
		const stop = await Arret.findOne({ $or: stopLookup }).lean();
		if (!stop) {
			const error = new Error("Arrêt introuvable.");
			error.status = 404;
			throw error;
		}

		// The Arret document can be a MERGED record (one physical hub grouping many
		// platforms with different line subsets). Querying realtime for all
		// physicalStopIds at once would mix in departures from neighbouring platforms
		// and surface lines that don't actually serve the exact stop the user tapped.
		// Resolve to the single stop the caller addressed: if the input is already a
		// STIB stop_id, use it as-is; only fall back to canonical/merged when the
		// caller passed the MongoDB ObjectId.
		const inputStopId = String(stopId).trim();
		const isObjectIdLookup = mongoose.isValidObjectId(stopId);
		const resolvedRealtimeId = isObjectIdLookup
			? (stop.stop_id || stop.merged_stop_id || null)
			: inputStopId;
		const stopRealtimeIds = resolvedRealtimeId
			? [String(resolvedRealtimeId).trim()].filter(Boolean)
			: [];

		const [signalements, waitingTimesResult, officialIncidentsResult] = await Promise.all([
			getRecentSignalements({ stopIds: [stop._id] }),
			stopRealtimeIds.length ? getWaitingTimesWithStatus({ stopId: stopRealtimeIds }) : {
				data: { items: [] },
				officialDataStatus: OFFICIAL_STATUS.AVAILABLE,
				officialDataMessage: null,
			},
			getTravellersInformationWithStatus({ stopId: stopRealtimeIds.length ? stopRealtimeIds : [stop.nom] }),
		]);
		const waitingTimes = waitingTimesResult.data;
		const officialIncidents = officialIncidentsResult.data;
		const officialStopLookup = await getStopsByRealtimeIds(officialIncidents.items.flatMap((item) => item.stops || []));
		const communityClusters = buildCommunityReportClusters(signalements);

		const activeIncidents = [
			...communityClusters,
			...signalements.map(mapIncident),
			...officialIncidents.items.slice(0, 5).map((item) => mapOfficialIncident(item, {
				stopLookup: officialStopLookup,
				defaultLine: Array.isArray(item.lines) ? item.lines[0] : item.lines || null,
			})),
		];

		let nextDepartures = summarizeDepartures(waitingTimes.items);
		const usedScheduledFallback = nextDepartures.length === 0;
		if (usedScheduledFallback) {
			nextDepartures = await getScheduledStopDepartures({
				stopIds: stopRealtimeIds,
				stopName: stop.nom,
				lines: stop.lignesDesservies || [],
				limit: 6,
			});
			nextDepartures = filterDeparturesForStopLines(nextDepartures, stop.lignesDesservies || []);
		} else {
			nextDepartures = await enrichDeparturesWithDelay(
				nextDepartures,
				stopRealtimeIds,
				stop.nom,
				stop.lignesDesservies || [],
			);
		}
		const servedLines = mergeStopLines(
			stop.lignesDesservies || [],
			nextDepartures.map((departure) => departure.line),
		);
		const severityInfo = computeRealtimeStatus({ incidents: activeIncidents, departures: nextDepartures });
		const officialDataStatus = mergeOfficialStatuses([
			waitingTimesResult.officialDataStatus,
			officialIncidentsResult.officialDataStatus,
		]);
		const baseOfficialDataMessage = firstOfficialMessage([
			waitingTimesResult.officialDataMessage,
			officialIncidentsResult.officialDataMessage,
		]);
		const officialDataMessage = usedScheduledFallback
			? buildScheduledFallbackMessage(baseOfficialDataMessage)
			: baseOfficialDataMessage;
		const perturbationSummary = buildPerturbationSummary({
			severity: severityInfo.severity,
			incidents: activeIncidents,
			departures: nextDepartures,
			officialDataStatus,
			officialDataMessage,
			crowdingRisk: buildCrowdingRisk({
				stop: {
					name: stop.nom,
					latitude: stop.latitude ?? null,
					longitude: stop.longitude ?? null,
					lines: servedLines,
				},
				lines: servedLines,
				stopNames: [stop.nom],
			}),
		});

		return {
			stop: {
				id: stop._id,
				stopId: stop.stop_id,
				name: stop.nom,
				latitude: stop.latitude,
				longitude: stop.longitude,
				lines: servedLines,
			},
			...severityInfo,
			officialDataStatus,
			officialDataMessage,
			perturbationSummary,
			activeIncidents,
			nextDepartures,
			recommendedAlternatives: [],
		};
	});
}

async function getTransportLine(lineId) {
	return cache.remember(stableKey("transport-line", { lineId }), TTL.lineOverview, async () => {
		const candidates = lineCandidates(lineId);
		const exactLine = await Ligne.findOne({ lineid: { $in: candidates } }).populate("points.id").lean();
		let line = exactLine;
		let mergedStops = null;

		if (!line) {
			const variants = await Ligne.find({ lineid: { $regex: `^${candidates[0]}:` } }).populate("points.id").lean();
			if (variants.length) {
				const primary = variants.find((variant) => variant.direction === "City") || variants[0];
				mergedStops = (primary.points || [])
					.slice()
					.sort((a, b) => a.order - b.order)
					.map((point) => point.id)
					.filter(Boolean);
				line = {
					...primary,
					lineid: candidates[0],
					points: mergedStops.map((stop, index) => ({ id: stop, order: index + 1 })),
				};
			}
		}

		if (!line) {
			const error = new Error("Ligne introuvable.");
			error.status = 404;
			throw error;
		}

		const stops = mergedStops || line.points
			.slice()
			.sort((a, b) => a.order - b.order)
			.map((point) => point.id)
			.filter(Boolean);

		const stopIds = stops.map((stop) => stop._id);
		const stopRealtimeIds = stops.map((stop) => stop.stop_id).filter(Boolean);

		const [signalements, waitingTimesResult, vehiclesResult, officialIncidentsResult] = await Promise.all([
			getRecentSignalements({ line: lineId, stopIds }),
			stopRealtimeIds.length ? getWaitingTimesWithStatus({ line: lineId, stopId: stopRealtimeIds }) : {
				data: { items: [] },
				officialDataStatus: OFFICIAL_STATUS.AVAILABLE,
				officialDataMessage: null,
			},
			getVehiclePositionsWithStatus({ line: lineId }),
			getTravellersInformationWithStatus({ line: lineId }),
		]);
		const waitingTimes = waitingTimesResult.data;
		const vehicles = vehiclesResult.data;
		const officialIncidents = officialIncidentsResult.data;
		const officialStopLookup = await getStopsByRealtimeIds(officialIncidents.items.flatMap((item) => item.stops || []));
		const communityClusters = buildCommunityReportClusters(signalements);

		const activeIncidents = [
			...communityClusters,
			...signalements.map(mapIncident),
			...officialIncidents.items.slice(0, 8).map((item) => mapOfficialIncident(item, {
				stopLookup: officialStopLookup,
				defaultLine: lineId,
			})),
		];

		let nextDepartures = summarizeDepartures(waitingTimes.items, lineId);
		const usedScheduledFallback = nextDepartures.length === 0;
		if (usedScheduledFallback) {
			const scheduledGroups = await Promise.all(
				stops.slice(0, 8).map((stop) =>
					getScheduledStopDepartures({
						stopIds: [
							stop.stop_id,
							stop.merged_stop_id,
							...(stop.physicalStopIds || []),
						],
						stopName: stop.nom,
						lines: [lineId],
						line: lineId,
						limit: 2,
					})
				)
			);
			nextDepartures = scheduledGroups
				.flat()
				.sort((left, right) => left.minutes - right.minutes)
				.slice(0, 6);
		}
		const severityInfo = computeRealtimeStatus({ incidents: activeIncidents, departures: nextDepartures });
		const officialDataStatus = mergeOfficialStatuses([
			waitingTimesResult.officialDataStatus,
			vehiclesResult.officialDataStatus,
			officialIncidentsResult.officialDataStatus,
		]);
		const baseOfficialDataMessage = firstOfficialMessage([
			waitingTimesResult.officialDataMessage,
			vehiclesResult.officialDataMessage,
			officialIncidentsResult.officialDataMessage,
		]);
		const officialDataMessage = usedScheduledFallback
			? buildScheduledFallbackMessage(baseOfficialDataMessage)
			: baseOfficialDataMessage;
		const perturbationSummary = buildPerturbationSummary({
			severity: severityInfo.severity,
			incidents: activeIncidents,
			departures: nextDepartures,
			officialDataStatus,
			officialDataMessage,
			crowdingRisk: buildCrowdingRisk({
				lineId,
				lines: [lineId],
				stops: stops.map((stop) => ({
					name: stop.nom,
					latitude: stop.latitude ?? null,
					longitude: stop.longitude ?? null,
					lines: stop.lignesDesservies || [],
				})),
				stopNames: stops.map((stop) => stop.nom),
			}),
		});

		return {
			line: {
				id: line._id,
				lineId: line.lineid,
				name: line.nomComplet,
				type: line.typeTransport,
				color: line.couleur,
				direction: line.direction,
				stops: stops.map((stop) => ({
					id: stop._id,
					stopId: stop.stop_id,
					name: stop.nom,
				})),
			},
			...severityInfo,
			officialDataStatus,
			officialDataMessage,
			perturbationSummary,
			activeIncidents,
			nextDepartures,
			vehicles: vehicles.items.slice(0, 50),
			recommendedAlternatives: [],
		};
	});
}

async function getTransportOverview({ lat, lng } = {}) {
	return cache.remember(
		stableKey("transport-overview", {
			lat: roundedCoordinate(lat),
			lng: roundedCoordinate(lng),
		}),
		15_000,
		async () => {
			const nearestStops = await Arret.find()
				.limit(6)
				.lean();

			const [overviewStops, officialIncidentsResult] = await Promise.all([
				Promise.all(nearestStops.map((stop) => getTransportStop(stop._id))),
				getTravellersInformationWithStatus({}),
			]);
			const officialIncidents = officialIncidentsResult.data;

			const officialStopLookup = await getStopsByRealtimeIds(officialIncidents.items.flatMap((item) => item.stops || []));
			const activeIncidents = officialIncidents.items.slice(0, 10).map((item) => mapOfficialIncident(item, {
				stopLookup: officialStopLookup,
			}));

			const severityInfo = summarizeSeverity([
				...overviewStops.map((stop) => ({ severity: stop.severity, confidence: stop.confidence })),
				...activeIncidents,
			]);
			const officialDataStatus = mergeOfficialStatuses([
				officialIncidentsResult.officialDataStatus,
				...overviewStops.map((stop) => stop.officialDataStatus),
			]);
			const officialDataMessage = firstOfficialMessage([
				officialIncidentsResult.officialDataMessage,
				...overviewStops.map((stop) => stop.officialDataMessage),
			]);
			const nextDepartures = overviewStops.flatMap((stop) => stop.nextDepartures).slice(0, 8);
			const perturbationSummary = buildPerturbationSummary({
				severity: severityInfo.severity,
				incidents: activeIncidents,
				departures: nextDepartures,
				officialDataStatus,
				officialDataMessage,
				crowdingRisk: buildCrowdingRisk({
					lat: typeof lat === "number" ? lat : null,
					lng: typeof lng === "number" ? lng : null,
					stops: overviewStops.map((stop) => ({
						name: stop.stop.name,
						latitude: stop.stop.latitude ?? null,
						longitude: stop.stop.longitude ?? null,
						lines: stop.stop.lines || [],
					})),
					lines: overviewStops.flatMap((stop) => stop.stop.lines || []),
					stopNames: overviewStops.map((stop) => stop.stop.name),
				}),
			});

			return {
				context: {
					lat: lat || null,
					lng: lng || null,
				},
				...severityInfo,
				realtimeStatus: severityInfo.realtimeStatus,
				officialDataStatus,
				officialDataMessage,
				perturbationSummary,
				activeIncidents,
				stops: overviewStops.map((stop) => stop.stop),
				nextDepartures,
				recommendedAlternatives: [],
			};
		}
	);
}

async function recommendRoute({ depart, destination, lignesBloquees = [] }) {
	const routeCacheKey = stableKey("transport-route-recommend", {
		depart: roundedCoordinateString(depart) || depart,
		destination: roundedCoordinateString(destination) || destination,
		lignesBloquees: [...new Set((lignesBloquees || []).map(normalizeLine).filter(Boolean))].sort(),
	});
	const staleRecommendation = getStaleCachedValue(routeCacheKey);

	return cache.remember(routeCacheKey, TTL.routeRecommend, async () => {
		const [transitRoutes, walkingRoutes, bikingRoutes, officialIncidentsResult] = await Promise.all([
			getCachedDirections({ depart, destination, mode: "transit" }),
			getCachedDirections({ depart, destination, mode: "walking" }),
			getCachedDirections({ depart, destination, mode: "bicycling" }),
			getTravellersInformationWithStatus({}),
		]);
		const officialIncidents = officialIncidentsResult.data;
		const routes = [
			...transitRoutes,
			...walkingRoutes.slice(0, 2),
			...bikingRoutes.slice(0, 2),
		];

		if (!routes.length) {
			if (hasTransitAlternatives(staleRecommendation)) {
				return buildStaleRouteRecommendation({
					staleRecommendation,
					officialDataStatus: officialIncidentsResult.officialDataStatus,
					officialDataMessage: officialIncidentsResult.officialDataMessage,
					message: "Les calculs live sont temporairement limites. Affichage du dernier meilleur itineraire connu.",
				});
			}

			return buildDegradedRouteResponse({
				depart,
				destination,
				lignesBloquees,
				officialDataStatus: officialIncidentsResult.officialDataStatus,
				officialDataMessage: officialIncidentsResult.officialDataMessage,
				message: "Les alternatives temps reel sont temporairement indisponibles. Verifie les perturbations proches avant de partir.",
			});
		}

		const allLines = [...new Set(routes.flatMap(extractTransitLines))];
		const since = new Date(Date.now() - 2 * 60 * 60 * 1000);
		const requestDate = new Date();
		const signalements = await Signalement.find({
			ligne: { $in: allLines },
			dateSignalement: { $gte: since },
			status: { $ne: "resolved" },
			moderationStatus: "approved",
		}).populate("arretId").lean();

		const officialStopLookup = await getStopsByRealtimeIds(officialIncidents.items.flatMap((item) => item.stops || []));
		const communityClusters = buildCommunityReportClusters(signalements);
		const incidents = [
			...communityClusters,
			...signalements.map(mapIncident),
			...officialIncidents.items.slice(0, 12).map((item) => mapOfficialIncident(item, {
				stopLookup: officialStopLookup,
				defaultLine: Array.isArray(item.lines) ? normalizeLine(item.lines[0]) : normalizeLine(item.lines),
			})),
		].filter((incident) => !lignesBloquees.includes(normalizeLine(incident.line)));

		const [waitingTimesResult, fragilitySnapshots] = await Promise.all([
			getWaitingTimesWithStatus({ line: allLines }),
			getFragilitySnapshots({ lines: allLines, hourBucket: requestDate.getHours() }),
		]);
		const waitingTimes = waitingTimesResult.data;
		const departures = summarizeDepartures(waitingTimes.items);
		const staticShapeFiles = getStaticShapeFilesForLines(allLines);
		const scoring = scoreRoutes({
			routes,
			incidents,
			departures,
			lignesBloquees,
			shapeFiles: staticShapeFiles,
			fragilitySnapshots,
			requestDate,
		});
		const topAlternativeLines = [...new Set(
			scoring.alternatives
				.flatMap((alternative) => alternative.data?.lines || [])
				.map(normalizeLine)
				.filter(Boolean)
		)];
		const vehiclesResult = topAlternativeLines.length
			? await getVehiclePositionsWithStatus({ line: topAlternativeLines })
			: {
				data: { payload: null, items: [] },
				officialDataStatus: OFFICIAL_STATUS.AVAILABLE,
				officialDataMessage: null,
			};
		const vehicles = vehiclesResult.data;
		const severityInfo = summarizeSeverity(scoring.scoredRoutes[0]?.incidents || incidents);
		const officialDataStatus = mergeOfficialStatuses([
			officialIncidentsResult.officialDataStatus,
			waitingTimesResult.officialDataStatus,
			vehiclesResult.officialDataStatus,
		]);
		const officialDataMessage = firstOfficialMessage([
			officialIncidentsResult.officialDataMessage,
			waitingTimesResult.officialDataMessage,
			vehiclesResult.officialDataMessage,
		]);
		let nextDepartures = departures.slice(0, 6);
		if (!nextDepartures.length) {
			nextDepartures = await getScheduledRouteDepartures(scoring.alternatives, 6);
		}
		const perturbationSummary = buildPerturbationSummary({
			severity: severityInfo.severity,
			incidents: incidents.slice(0, 10),
			departures: nextDepartures,
			officialDataStatus,
			officialDataMessage,
			crowdingRisk: buildCrowdingRisk({
				lines: allLines,
				stopNames: routes.flatMap(collectTransitStops),
			}),
		});

		const recommendation = {
			request: { depart, destination, lignesBloquees },
			...severityInfo,
			officialDataStatus,
			officialDataMessage,
			perturbationSummary,
			activeIncidents: incidents.slice(0, 10),
			nextDepartures,
			recommendedAlternatives: scoring.alternatives.map((alternative) =>
				enrichAlternativeRealtime(alternative, {
					waitingItems: waitingTimes.items,
					vehicleItems: vehicles.items,
					officialItems: officialIncidents.items,
					requestDate,
				})
			),
		};

		if (!hasTransitAlternatives(recommendation) && hasTransitAlternatives(staleRecommendation)) {
			return buildStaleRouteRecommendation({
				staleRecommendation,
				officialDataStatus,
				officialDataMessage: officialDataMessage || "Les enrichissements temps reel sont limites. Affichage du dernier trajet transport fiable.",
				message: "Le calcul live manque de donnees transport. Affichage du dernier itineraire transport fiable.",
			});
		}

		return recommendation;
	});
}

module.exports = {
	getTransportLine,
	getTransportOverview,
	getTransportStop,
	recommendRoute,
};
