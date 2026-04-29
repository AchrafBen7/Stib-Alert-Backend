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

function normalizeLine(line) {
	return String(line || "").trim();
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

function mergeOfficialStatuses(statuses = []) {
	const normalized = statuses.filter(Boolean);
	if (normalized.includes(OFFICIAL_STATUS.UNAVAILABLE)) return OFFICIAL_STATUS.UNAVAILABLE;
	if (normalized.includes(OFFICIAL_STATUS.LIMITED)) return OFFICIAL_STATUS.LIMITED;
	return OFFICIAL_STATUS.AVAILABLE;
}

function firstOfficialMessage(messages = []) {
	return messages.find(Boolean) || null;
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

		const [signalements, waitingTimesResult, officialIncidentsResult] = await Promise.all([
			getRecentSignalements({ stopIds: [stop._id] }),
			stop.stop_id ? getWaitingTimesWithStatus({ stopId: stop.stop_id }) : {
				data: { items: [] },
				officialDataStatus: OFFICIAL_STATUS.AVAILABLE,
				officialDataMessage: null,
			},
			getTravellersInformationWithStatus({ stopId: stop.stop_id || stop.nom }),
		]);
		const waitingTimes = waitingTimesResult.data;
		const officialIncidents = officialIncidentsResult.data;

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
		const officialDataStatus = mergeOfficialStatuses([
			waitingTimesResult.officialDataStatus,
			officialIncidentsResult.officialDataStatus,
		]);
		const officialDataMessage = firstOfficialMessage([
			waitingTimesResult.officialDataMessage,
			officialIncidentsResult.officialDataMessage,
		]);
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
					lines: stop.lignesDesservies || [],
				},
				lines: stop.lignesDesservies || [],
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
				lines: stop.lignesDesservies || [],
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
				const stopMap = new Map();
				variants.forEach((variant) => {
					(variant.points || []).forEach((point) => {
						const stop = point.id;
						if (!stop?._id) return;
						const key = String(stop._id);
						const existing = stopMap.get(key);
						if (!existing || point.order < existing.order) {
							stopMap.set(key, {
								stop,
								order: point.order,
							});
						}
					});
				});
				mergedStops = [...stopMap.values()]
					.sort((a, b) => a.order - b.order)
					.map((entry) => entry.stop);
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
		const officialDataStatus = mergeOfficialStatuses([
			waitingTimesResult.officialDataStatus,
			vehiclesResult.officialDataStatus,
			officialIncidentsResult.officialDataStatus,
		]);
		const officialDataMessage = firstOfficialMessage([
			waitingTimesResult.officialDataMessage,
			vehiclesResult.officialDataMessage,
			officialIncidentsResult.officialDataMessage,
		]);
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
	const [transitRoutes, walkingRoutes, bikingRoutes, officialIncidentsResult] = await Promise.all([
		getCachedDirections({ depart, destination, mode: "transit" }),
		getCachedDirections({ depart, destination, mode: "walking" }),
		getCachedDirections({ depart, destination, mode: "bicycling" }),
		getTravellersInformationWithStatus({}),
	]);
	const officialIncidents = officialIncidentsResult.data;
	const routes = [
		...transitRoutes,
		...walkingRoutes.slice(0, 1),
		...bikingRoutes.slice(0, 1),
	];

	if (!routes.length) {
		return {
			request: { depart, destination, lignesBloquees },
			severity: SEVERITY.MINOR,
			confidence: 0.55,
			realtimeStatus: "fallback",
			officialDataStatus: officialIncidentsResult.officialDataStatus,
			officialDataMessage: officialIncidentsResult.officialDataMessage,
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

	const [waitingTimesResult, shapeFiles, fragilitySnapshots] = await Promise.all([
		getWaitingTimesWithStatus({ line: allLines }),
		getCachedShapeFiles({ line: allLines }),
		getFragilitySnapshots({ lines: allLines, hourBucket: requestDate.getHours() }),
	]);
	const waitingTimes = waitingTimesResult.data;
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
	const officialDataStatus = mergeOfficialStatuses([
		officialIncidentsResult.officialDataStatus,
		waitingTimesResult.officialDataStatus,
	]);
	const officialDataMessage = firstOfficialMessage([
		officialIncidentsResult.officialDataMessage,
		waitingTimesResult.officialDataMessage,
	]);
	const nextDepartures = departures.slice(0, 6);
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

	return {
		request: { depart, destination, lignesBloquees },
		...severityInfo,
		officialDataStatus,
		officialDataMessage,
		perturbationSummary,
		activeIncidents: incidents.slice(0, 10),
		nextDepartures,
		recommendedAlternatives: scoring.alternatives,
	};
}

module.exports = {
	getTransportLine,
	getTransportOverview,
	getTransportStop,
	recommendRoute,
};
