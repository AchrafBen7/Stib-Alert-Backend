const Arret = require("../models/Arret");
const Ligne = require("../models/Ligne");
const Signalement = require("../models/Signalement");
const { getTravellersInformation, getWaitingTimes, getVehiclePositions, getShapeFiles } = require("./belgianMobility");
const { fetchItinerairesGoogle } = require("./googleDirections");
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

const TTL = {
	waitingTimes: 20_000,
	vehiclePositions: 15_000,
	travellersInformation: 45_000,
	shapeFiles: 6 * 60 * 60 * 1000,
	stopOverview: 20_000,
	lineOverview: 20_000,
	routeRecommend: 90_000,
};

function stableKey(prefix, payload) {
	return `${prefix}:${JSON.stringify(payload)}`;
}

function normalizeLine(line) {
	return String(line || "").trim();
}

function toMinutes(value) {
	if (typeof value === "number" && Number.isFinite(value)) return Math.max(Math.round(value), 0);
	if (typeof value !== "string") return null;
	if (/^(due|now)$/i.test(value.trim())) return 0;
	const match = value.match(/(\d+)/);
	return match ? Math.max(Number.parseInt(match[1], 10), 0) : null;
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

async function getCachedDirections(query) {
	return cache.remember(
		stableKey("google-directions", query),
		TTL.routeRecommend,
		async () => fetchItinerairesGoogle(query.depart, query.destination)
	);
}

async function getRecentSignalements({ line, stopIds = [], limit = 100 } = {}) {
	const since = new Date(Date.now() - 2 * 60 * 60 * 1000);
	const query = {
		dateSignalement: { $gte: since },
		status: { $ne: "resolved" },
	};

	if (line) query.ligne = line;
	if (stopIds.length) query.arretId = { $in: stopIds };

	return Signalement.find(query)
		.sort({ dateSignalement: -1 })
		.limit(limit)
		.populate("arretId")
		.lean();
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

function summarizeDepartures(waitingItems = [], lineFilter = null) {
	const departures = waitingItems
		.filter((item) => !lineFilter || normalizeLine(item.line) === normalizeLine(lineFilter))
		.map((item) => ({
			line: normalizeLine(item.line),
			destination: item.destination || null,
			minutes: toMinutes(item.minutes),
		}))
		.filter((item) => item.line && item.minutes !== null)
		.sort((a, b) => a.minutes - b.minutes);

	return departures.slice(0, 6);
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
		const stop = await Arret.findById(stopId).lean();
		if (!stop) {
			const error = new Error("Arrêt introuvable.");
			error.status = 404;
			throw error;
		}

		const [signalements, waitingTimes, officialIncidents] = await Promise.all([
			getRecentSignalements({ stopIds: [stop._id] }),
			stop.stop_id ? getCachedWaitingTimes({ stopId: stop.stop_id }) : { items: [] },
			getCachedTravellersInformation({ stopId: stop.stop_id || stop.nom }),
		]);

		const activeIncidents = [
			...signalements.map(mapIncident),
			...officialIncidents.items.slice(0, 5).map((item) => ({
				id: item.id,
				type: item.title || "Information STIB",
				description: item.description,
				severity: SEVERITY.MAJOR,
				confidence: 0.85,
				source: "official",
				line: Array.isArray(item.lines) ? item.lines[0] : item.lines || null,
				stop: { id: stop._id, name: stop.nom },
				date: item.updatedAt || null,
			})),
		];

		const nextDepartures = summarizeDepartures(waitingTimes.items);
		const severityInfo = computeRealtimeStatus({ incidents: activeIncidents, departures: nextDepartures });

		return {
			stop: {
				id: stop._id,
				stopId: stop.stop_id,
				name: stop.nom,
				latitude: stop.latitude,
				longitude: stop.longitude,
				lines: stop.lignesDesservies || [],
			},
			...severityInfo,
			activeIncidents,
			nextDepartures,
			recommendedAlternatives: [],
		};
	});
}

async function getTransportLine(lineId) {
	return cache.remember(stableKey("transport-line", { lineId }), TTL.lineOverview, async () => {
		const line = await Ligne.findOne({ lineid: lineId }).populate("points.id").lean();
		if (!line) {
			const error = new Error("Ligne introuvable.");
			error.status = 404;
			throw error;
		}

		const stops = line.points
			.slice()
			.sort((a, b) => a.order - b.order)
			.map((point) => point.id)
			.filter(Boolean);

		const stopIds = stops.map((stop) => stop._id);
		const stopRealtimeIds = stops.map((stop) => stop.stop_id).filter(Boolean);

		const [signalements, waitingTimes, vehicles, officialIncidents] = await Promise.all([
			getRecentSignalements({ line: lineId, stopIds }),
			stopRealtimeIds.length ? getCachedWaitingTimes({ line: lineId, stopId: stopRealtimeIds }) : { items: [] },
			getCachedVehiclePositions({ line: lineId }),
			getCachedTravellersInformation({ line: lineId }),
		]);

		const activeIncidents = [
			...signalements.map(mapIncident),
			...officialIncidents.items.slice(0, 8).map((item) => ({
				id: item.id,
				type: item.title || "Information STIB",
				description: item.description,
				severity: SEVERITY.MAJOR,
				confidence: 0.85,
				source: "official",
				line: lineId,
				stop: null,
				date: item.updatedAt || null,
			})),
		];

		const nextDepartures = summarizeDepartures(waitingTimes.items, lineId);
		const severityInfo = computeRealtimeStatus({ incidents: activeIncidents, departures: nextDepartures });

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
			activeIncidents,
			nextDepartures,
			vehicles: vehicles.items.slice(0, 50),
			recommendedAlternatives: [],
		};
	});
}

async function getTransportOverview({ lat, lng } = {}) {
	const nearestStops = await Arret.find()
		.limit(6)
		.lean();

	const [overviewStops, officialIncidents] = await Promise.all([
		Promise.all(nearestStops.map((stop) => getTransportStop(stop._id))),
		getCachedTravellersInformation({}),
	]);

	const activeIncidents = officialIncidents.items.slice(0, 10).map((item) => ({
		id: item.id,
		type: item.title || "Information STIB",
		description: item.description,
		severity: SEVERITY.MAJOR,
		confidence: 0.85,
		source: "official",
		line: Array.isArray(item.lines) ? item.lines[0] : item.lines || null,
		stop: null,
		date: item.updatedAt || null,
	}));

	const severityInfo = summarizeSeverity([
		...overviewStops.map((stop) => ({ severity: stop.severity, confidence: stop.confidence })),
		...activeIncidents,
	]);

	return {
		context: {
			lat: lat || null,
			lng: lng || null,
		},
		...severityInfo,
		realtimeStatus: severityInfo.realtimeStatus,
		activeIncidents,
		stops: overviewStops.map((stop) => stop.stop),
		nextDepartures: overviewStops.flatMap((stop) => stop.nextDepartures).slice(0, 8),
		recommendedAlternatives: [],
	};
}

async function recommendRoute({ depart, destination, lignesBloquees = [] }) {
	const [routes, officialIncidents] = await Promise.all([
		getCachedDirections({ depart, destination }),
		getCachedTravellersInformation({}),
	]);

	if (!routes.length) {
		return {
			request: { depart, destination, lignesBloquees },
			severity: SEVERITY.MINOR,
			confidence: 0.55,
			realtimeStatus: "fallback",
			activeIncidents: [],
			nextDepartures: [],
			recommendedAlternatives: [],
			fallback: {
				reason: "directions_unavailable",
				message: "Les alternatives temps réel sont temporairement indisponibles. Vérifie les perturbations proches avant de partir.",
			},
		};
	}

	const allLines = [...new Set(routes.flatMap(extractTransitLines))];
	const since = new Date(Date.now() - 2 * 60 * 60 * 1000);
	const requestDate = new Date();
	const signalements = await Signalement.find({
		ligne: { $in: allLines },
		dateSignalement: { $gte: since },
		status: { $ne: "resolved" },
	}).populate("arretId").lean();

	const incidents = [
		...signalements.map(mapIncident),
		...officialIncidents.items.slice(0, 12).map((item) => ({
			id: item.id,
			type: item.title || "Information STIB",
			description: item.description,
			severity: SEVERITY.MAJOR,
			confidence: 0.85,
			source: "official",
			line: Array.isArray(item.lines) ? normalizeLine(item.lines[0]) : normalizeLine(item.lines),
			stop: null,
			date: item.updatedAt || null,
		})),
	].filter((incident) => !lignesBloquees.includes(normalizeLine(incident.line)));

	const [waitingTimes, shapeFiles, fragilitySnapshots] = await Promise.all([
		getCachedWaitingTimes({ line: allLines }),
		getCachedShapeFiles({ line: allLines }),
		getFragilitySnapshots({ lines: allLines, hourBucket: requestDate.getHours() }),
	]);
	const departures = summarizeDepartures(waitingTimes.items);
	const scoring = scoreRoutes({
		routes,
		incidents,
		departures,
		lignesBloquees,
		shapeFiles: shapeFiles.items,
		fragilitySnapshots,
		requestDate,
	});
	const severityInfo = summarizeSeverity(scoring.scoredRoutes[0]?.incidents || incidents);

	return {
		request: { depart, destination, lignesBloquees },
		...severityInfo,
		activeIncidents: incidents.slice(0, 10),
		nextDepartures: departures.slice(0, 6),
		recommendedAlternatives: scoring.alternatives,
	};
}

module.exports = {
	getTransportLine,
	getTransportOverview,
	getTransportStop,
	recommendRoute,
};
