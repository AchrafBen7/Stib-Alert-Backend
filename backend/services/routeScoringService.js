const { SEVERITY, summarizeSeverity } = require("./transportSeverity");

const DEFAULT_WEIGHTS = {
	duration: 1,
	walking: 1.55,
	transfers: 6.5,
	waitingAverage: 1.2,
	waitingVariance: 0.95,
	corridorIncident: 1.2,
	transferFragility: 4.5,
	blockedLine: 18,
	stopFragility: 4.4,
	corridorGeographic: 6.5,
	corridorShape: 7.2,
};

const ACTIVE_MODE_LIMITS = {
	walkMaxMinutes: 24,
	bikeMaxMinutes: 32,
	walkSoftPenaltyAfterMinutes: 14,
	bikeSoftPenaltyAfterMinutes: 20,
};

function normalizeLine(line) {
	return String(line || "").trim();
}

function routeWalkDuration(route) {
	return route.legs.reduce((sum, leg) => {
		return sum + leg.steps
			.filter((step) => step.travel_mode === "WALKING")
			.reduce((acc, step) => acc + (step.duration?.value || 0), 0);
	}, 0);
}

function routeBikeDuration(route) {
	return route.legs.reduce((sum, leg) => {
		return sum + leg.steps
			.filter((step) => step.travel_mode === "BICYCLING")
			.reduce((acc, step) => acc + (step.duration?.value || 0), 0);
	}, 0);
}

function routeTransfers(route) {
	const transitSteps = route.legs.reduce((sum, leg) => sum + leg.steps.filter((step) => step.travel_mode === "TRANSIT").length, 0);
	return Math.max(transitSteps - 1, 0);
}

function routeTotalDuration(route) {
	return route.legs.reduce((sum, leg) => sum + (leg.duration?.value || 0), 0);
}

function routePrimaryMode(route) {
	const modes = route.legs.flatMap((leg) => (leg.steps || []).map((step) => String(step.travel_mode || "").toUpperCase()));
	if (modes.includes("TRANSIT")) return "transit";
	if (modes.includes("BICYCLING")) return "bike";
	if (modes.includes("WALKING")) return "walk";
	return "unknown";
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

function collectTransferStops(route) {
	return route.legs.flatMap((leg) =>
		leg.steps
			.filter((step) => step.travel_mode === "TRANSIT")
			.slice(1)
			.map((step) => step.transit_details?.departure_stop?.name)
			.filter(Boolean)
	);
}

function cleanInstruction(instruction) {
	return String(instruction || "")
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function toMinutes(valueSeconds) {
	return Math.max(Math.round((valueSeconds || 0) / 60), 0);
}

function activeModeDurationPenalty({ primaryMode, totalDurationMinutes }) {
	if (primaryMode === "walk") {
		const overflow = Math.max(totalDurationMinutes - ACTIVE_MODE_LIMITS.walkSoftPenaltyAfterMinutes, 0);
		return overflow * 3.4;
	}
	if (primaryMode === "bike") {
		const overflow = Math.max(totalDurationMinutes - ACTIVE_MODE_LIMITS.bikeSoftPenaltyAfterMinutes, 0);
		return overflow * 2.2;
	}
	return 0;
}

function isEligibleActiveAlternative(scoredRoute) {
	const totalDurationMinutes = toMinutes(scoredRoute.totalDurationSeconds);
	if (scoredRoute.primaryMode === "walk") {
		return totalDurationMinutes <= ACTIVE_MODE_LIMITS.walkMaxMinutes;
	}
	if (scoredRoute.primaryMode === "bike") {
		return totalDurationMinutes <= ACTIVE_MODE_LIMITS.bikeMaxMinutes;
	}
	return false;
}

function isTransitDisruptionImportant(bestTransitRoute) {
	if (!bestTransitRoute) return false;
	if ((bestTransitRoute.blockedLines || []).length > 0) return true;
	if (bestTransitRoute.severity === SEVERITY.CRITICAL || bestTransitRoute.severity === SEVERITY.MAJOR) return true;
	if ((bestTransitRoute.incidents || []).length >= 2) return true;
	if ((bestTransitRoute.corridorGeographicPenalty || 0) >= 10) return true;
	if ((bestTransitRoute.corridorShapePenalty || 0) >= 10) return true;
	if ((bestTransitRoute.transferFragility || 0) >= 5) return true;
	return false;
}

function shouldExposeWalkAlternative(walkRoute, bestTransitRoute) {
	if (!walkRoute || !isEligibleActiveAlternative(walkRoute)) return false;
	return isTransitDisruptionImportant(bestTransitRoute);
}

function shouldExposeBikeAlternative(bikeRoute, bestTransitRoute) {
	if (!bikeRoute || !isEligibleActiveAlternative(bikeRoute)) return false;
	if (!bestTransitRoute) return true;

	const transitDuration = toMinutes(bestTransitRoute.totalDurationSeconds);
	const bikeDuration = toMinutes(bikeRoute.totalDurationSeconds);
	const significantlyFaster = bikeDuration <= Math.max(transitDuration - 6, 0);
	const materiallyMoreReliable = bikeRoute.confidence >= bestTransitRoute.confidence + 0.12
		|| bikeRoute.severity === SEVERITY.NORMAL && bestTransitRoute.severity !== SEVERITY.NORMAL;

	return significantlyFaster || materiallyMoreReliable;
}

function computeWaitingStats(lines, departures) {
	if (!lines.length) {
		return {
			averageWait: 0,
			variance: 0,
			sample: [],
		};
	}

	const relevant = departures.filter((departure) => lines.includes(normalizeLine(departure.line)));
	const values = relevant.slice(0, 5).map((departure) => departure.minutes).filter((value) => Number.isFinite(value));
	if (!values.length) {
		return {
			averageWait: 12,
			variance: 5,
			sample: [],
		};
	}

	const averageWait = values.reduce((sum, value) => sum + value, 0) / values.length;
	const variance = values.length === 1
		? 0
		: values.reduce((sum, value) => sum + ((value - averageWait) ** 2), 0) / values.length;

	return {
		averageWait,
		variance: Math.sqrt(variance),
		sample: values,
	};
}

function freshnessMultiplier(freshnessMinutes) {
	if (freshnessMinutes <= 5) return 1.18;
	if (freshnessMinutes <= 15) return 1.05;
	if (freshnessMinutes <= 45) return 0.88;
	if (freshnessMinutes <= 90) return 0.72;
	return 0.52;
}

function severityWeight(severity) {
	switch (severity) {
	case SEVERITY.CRITICAL: return 20;
	case SEVERITY.MAJOR: return 12;
	case SEVERITY.MINOR: return 5;
	default: return 0;
	}
}

function computeIncidentPenalty(incidents) {
	return incidents.reduce((sum, incident) => {
		const base = severityWeight(incident.severity);
		const freshness = freshnessMultiplier(incident.community?.freshnessMinutes ?? 45);
		const sourceWeight = incident.source === "official" ? 1.05 : 1;
		const confirmations = incident.community?.confirmations || 0;
		const stillBlocked = incident.community?.stillBlocked || 0;
		const resolved = incident.community?.resolved || 0;
		const recentBoost = (incident.community?.freshnessMinutes ?? 999) <= 10 ? 1.12 : 1;
		const communityWeight = recentBoost * (
			1
			+ Math.min(confirmations * 0.08, 0.36)
			+ Math.min(stillBlocked * 0.12, 0.42)
			- Math.min(resolved * 0.08, 0.24)
		);
		const resolvedReduction = incident.community?.status === "resolved" ? 0.25 : 1;
		return sum + base * (incident.confidence || 0.6) * freshness * sourceWeight * communityWeight * resolvedReduction;
	}, 0);
}

function toRadians(value) {
	return (value * Math.PI) / 180;
}

function distanceMeters(a, b) {
	if (!a || !b) return Number.POSITIVE_INFINITY;
	const earthRadius = 6371000;
	const dLat = toRadians(b.lat - a.lat);
	const dLng = toRadians(b.lng - a.lng);
	const lat1 = toRadians(a.lat);
	const lat2 = toRadians(b.lat);
	const sinLat = Math.sin(dLat / 2);
	const sinLng = Math.sin(dLng / 2);
	const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
	return 2 * earthRadius * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function extractRouteCoordinates(route) {
	return route.legs.flatMap((leg) =>
		(leg.steps || []).flatMap((step) => {
			const coords = [];
			if (step.start_location?.lat != null && step.start_location?.lng != null) {
				coords.push({ lat: step.start_location.lat, lng: step.start_location.lng });
			}
			if (step.end_location?.lat != null && step.end_location?.lng != null) {
				coords.push({ lat: step.end_location.lat, lng: step.end_location.lng });
			}
			if (step.transit_details?.departure_stop?.location?.lat != null && step.transit_details?.departure_stop?.location?.lng != null) {
				coords.push({
					lat: step.transit_details.departure_stop.location.lat,
					lng: step.transit_details.departure_stop.location.lng,
				});
			}
			if (step.transit_details?.arrival_stop?.location?.lat != null && step.transit_details?.arrival_stop?.location?.lng != null) {
				coords.push({
					lat: step.transit_details.arrival_stop.location.lat,
					lng: step.transit_details.arrival_stop.location.lng,
				});
			}
			return coords;
		})
	);
}

function buildShapeIndex(shapeFiles = []) {
	const index = new Map();
	for (const shape of shapeFiles) {
		const line = normalizeLine(shape.line);
		if (!line) continue;
		const coords = (shape.polylines || []).flatMap((polyline) =>
			(polyline || []).map((pair) => ({ lat: pair[1], lng: pair[0] }))
		).filter((coord) => Number.isFinite(coord.lat) && Number.isFinite(coord.lng));
		if (!coords.length) continue;
		const current = index.get(line) || [];
		current.push(...coords);
		index.set(line, current);
	}
	return index;
}

function dedupeCoordinates(coords = []) {
	const seen = new Set();
	return coords.filter((coord) => {
		if (!Number.isFinite(coord?.lat) || !Number.isFinite(coord?.lng)) return false;
		const key = `${coord.lat.toFixed(6)}:${coord.lng.toFixed(6)}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function findClosestCoordinateIndex(coords = [], target = null) {
	if (!coords.length || !target) return -1;
	let bestIndex = -1;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (let index = 0; index < coords.length; index += 1) {
		const distance = distanceMeters(coords[index], target);
		if (distance < bestDistance) {
			bestDistance = distance;
			bestIndex = index;
		}
	}
	return bestIndex;
}

function buildStepPathFromShape(line, startPoint, endPoint, shapeIndex) {
	const coords = shapeIndex.get(normalizeLine(line)) || [];
	if (!coords.length || !startPoint || !endPoint) {
		return dedupeCoordinates([startPoint, endPoint].filter(Boolean));
	}

	const startIndex = findClosestCoordinateIndex(coords, startPoint);
	const endIndex = findClosestCoordinateIndex(coords, endPoint);
	if (startIndex < 0 || endIndex < 0) {
		return dedupeCoordinates([startPoint, endPoint].filter(Boolean));
	}

	const slice = startIndex <= endIndex
		? coords.slice(startIndex, endIndex + 1)
		: coords.slice(endIndex, startIndex + 1).reverse();

	const path = dedupeCoordinates([startPoint, ...slice, endPoint]);
	return path.length >= 2 ? path : dedupeCoordinates([startPoint, endPoint].filter(Boolean));
}

function computeCorridorGeographicPenalty(routeCoords, incidents) {
	if (!routeCoords.length) return 0;

	return incidents.reduce((sum, incident) => {
		const lat = incident.stop?.latitude ?? incident.latitude ?? null;
		const lng = incident.stop?.longitude ?? incident.longitude ?? null;
		if (lat == null || lng == null) {
			return sum + (incident.source === "official" ? severityWeight(incident.severity) * 0.05 : 0);
		}

		const nearestDistance = routeCoords.reduce((best, coord) => {
			const current = distanceMeters(coord, { lat, lng });
			return Math.min(best, current);
		}, Number.POSITIVE_INFINITY);

		let proximityWeight = 0;
		if (nearestDistance <= 100) proximityWeight = 1;
		else if (nearestDistance <= 180) proximityWeight = 0.65;
		else if (nearestDistance <= 280) proximityWeight = 0.35;
		else if (nearestDistance <= 450) proximityWeight = 0.12;
		else return sum;

		const freshness = freshnessMultiplier(incident.community?.freshnessMinutes ?? 45);
		const confidence = incident.confidence || 0.6;
		return sum + severityWeight(incident.severity) * confidence * freshness * proximityWeight;
	}, 0);
}

function computeShapeCorridorPenalty(lines, shapeIndex, incidents) {
	const relevantShapeCoords = lines.flatMap((line) => shapeIndex.get(normalizeLine(line)) || []);
	if (!relevantShapeCoords.length) return 0;

	return incidents.reduce((sum, incident) => {
		const lat = incident.stop?.latitude ?? incident.latitude ?? null;
		const lng = incident.stop?.longitude ?? incident.longitude ?? null;
		if (lat == null || lng == null) return sum;

		const nearestDistance = relevantShapeCoords.reduce((best, coord) => {
			const current = distanceMeters(coord, { lat, lng });
			return Math.min(best, current);
		}, Number.POSITIVE_INFINITY);

		let proximityWeight = 0;
		if (nearestDistance <= 80) proximityWeight = 1;
		else if (nearestDistance <= 140) proximityWeight = 0.72;
		else if (nearestDistance <= 220) proximityWeight = 0.45;
		else if (nearestDistance <= 320) proximityWeight = 0.2;
		else return sum;

		const confirmations = incident.community?.confirmations || 0;
		const stillBlocked = incident.community?.stillBlocked || 0;
		const freshness = freshnessMultiplier(incident.community?.freshnessMinutes ?? 45);
		return sum + severityWeight(incident.severity)
			* (incident.confidence || 0.6)
			* freshness
			* proximityWeight
			* (1 + Math.min((confirmations + stillBlocked) * 0.05, 0.3));
	}, 0);
}

function computeTransferFragility(transferStops, incidents) {
	if (!transferStops.length) return 0;
	return transferStops.reduce((sum, stopName) => {
		const localized = String(stopName).toLowerCase();
		const localPenalty = incidents.reduce((incidentSum, incident) => {
			const incidentStop = String(incident.stop?.name || "").toLowerCase();
			if (!incidentStop || !localized.includes(incidentStop) && !incidentStop.includes(localized)) {
				return incidentSum;
			}
			return incidentSum + severityWeight(incident.severity) * (incident.confidence || 0.6) * 0.32;
		}, 0);
		return sum + localPenalty;
	}, 0);
}

function computeStopFragility(stopNames, incidents) {
	if (!stopNames.length) return 0;
	const normalizedStops = stopNames.map((name) => String(name).toLowerCase());
	return incidents.reduce((sum, incident) => {
		const incidentStop = String(incident.stop?.name || "").toLowerCase();
		if (!incidentStop) return sum;
		const isMatched = normalizedStops.some((name) => name.includes(incidentStop) || incidentStop.includes(name));
		if (!isMatched) return sum;
		return sum + severityWeight(incident.severity) * (incident.confidence || 0.6) * 0.18;
	}, 0);
}

function computeHistoricalStopFragility(stopNames, fragilitySnapshots = [], requestDate = new Date(), lines = []) {
	if (!stopNames.length || !fragilitySnapshots.length) return 0;
	const normalizedStops = stopNames.map((name) => String(name).toLowerCase());
	const normalizedLines = lines.map(normalizeLine);

	return fragilitySnapshots.reduce((sum, snapshot) => {
		const stopName = String(snapshot.stopNameLower || "").toLowerCase();
		if (!stopName) return sum;
		const isMatched = normalizedStops.some((name) => name.includes(stopName) || stopName.includes(name));
		if (!isMatched) return sum;
		if (snapshot.line && normalizedLines.length && !normalizedLines.includes(normalizeLine(snapshot.line))) return sum;
		const communityWeight = 1 + Math.min(((snapshot.confirmations || 0) + (snapshot.stillBlocked || 0)) * 0.02, 0.2);
		return sum + (snapshot.score || 0) * communityWeight * 0.12;
	}, 0);
}

function buildReasons({
	incidentPenalty,
	corridorGeographicPenalty,
	corridorShapePenalty,
	transferFragility,
	stopFragility,
	waitingStats,
	blockedLines,
	walkingMinutes,
	primaryMode,
	totalDurationMinutes,
}) {
	const reasons = [];

	if (primaryMode === "bike") {
		reasons.push("Cette option evite les correspondances STIB et reste directe a velo.");
	}
	if (primaryMode === "walk" && totalDurationMinutes <= 22) {
		reasons.push("Le trajet reste faisable a pied sans dependre du reseau.");
	}

	if (blockedLines.length) {
		reasons.push(`J’évite la ligne ${blockedLines[0]} car elle reste fortement perturbée.`);
	}
	if (corridorGeographicPenalty >= 10) {
		reasons.push("Plusieurs incidents tombent directement sur le corridor emprunté.");
	}
	if (corridorShapePenalty >= 10) {
		reasons.push("Le tracé STIB officiel de cette ligne traverse une zone sous tension.");
	}
	if (incidentPenalty >= 18) {
		reasons.push("Le corridor le plus rapide reste trop exposé à des incidents récents.");
	}
	if (transferFragility >= 5) {
		reasons.push("Cette option réduit une correspondance fragile.");
	}
	if (stopFragility >= 4) {
		reasons.push("Les arrêts de correspondance paraissent historiquement instables sur ce créneau.");
	}
	if (waitingStats.variance >= 5) {
		reasons.push("Les temps d’attente paraissent instables sur les lignes concurrentes.");
	}
	if (walkingMinutes <= 6) {
		reasons.push("La marche reste contenue.");
	}

	return reasons.slice(0, 3);
}

function buildExplanationDetails(scoredRoute) {
	const categories = [];

	if (scoredRoute.primaryMode === "bike") {
		categories.push({
			key: "bike_route",
			title: "Alternative velo",
			impact: "positive",
			detail: "Cette option s'appuie sur un trajet velo direct pour reduire la dependance au reseau STIB.",
		});
	}
	if (scoredRoute.primaryMode === "walk") {
		categories.push({
			key: "walk_route",
			title: "Alternative a pied",
			impact: scoredRoute.totalDurationSeconds <= 20 * 60 ? "positive" : "medium",
			detail: "Cette option peut etre realisee a pied si tu preferes eviter les perturbations du reseau.",
		});
	}

	if (scoredRoute.blockedLines?.length) {
		categories.push({
			key: "blocked_line",
			title: "Ligne bloquée",
			impact: "high",
			detail: `La ligne ${scoredRoute.blockedLines[0]} est actuellement pénalisée fortement.`,
		});
	}
	if (scoredRoute.corridorShapePenalty >= 10 || scoredRoute.corridorGeographicPenalty >= 10) {
		categories.push({
			key: "corridor_risk",
			title: "Corridor à risque",
			impact: scoredRoute.corridorShapePenalty >= 16 ? "high" : "medium",
			detail: "Le corridor réel emprunté recoupe une zone avec incidents récents et confirmations terrain.",
		});
	}
	if (scoredRoute.transferFragility >= 5) {
		categories.push({
			key: "transfer_fragility",
			title: "Correspondance fragile",
			impact: "medium",
			detail: "Cette option dépend d’une correspondance plus sensible aux perturbations.",
		});
	}
	if (scoredRoute.waitingVariance >= 5) {
		categories.push({
			key: "waiting_instability",
			title: "Attente instable",
			impact: "medium",
			detail: "Les prochains passages disponibles varient fortement sur cette option.",
		});
	}
	if (scoredRoute.stopFragility >= 4) {
		categories.push({
			key: "stop_fragility",
			title: "Arrêt fragile",
			impact: "medium",
			detail: "Les arrêts de ce trajet montrent une instabilité récurrente sur ce créneau horaire.",
		});
	}
	if (scoredRoute.walkingDurationSeconds <= 6 * 60) {
		categories.push({
			key: "walking",
			title: "Marche contenue",
			impact: "positive",
			detail: "La marche reste limitée sur cette alternative.",
		});
	}

	const riskLevel =
		scoredRoute.score <= 45 ? "low"
			: scoredRoute.score <= 72 ? "moderate"
				: scoredRoute.score <= 95 ? "elevated"
					: "high";

	return {
		riskLevel,
		summary: scoredRoute.reasons[0] || "Cet itinéraire reste le meilleur compromis disponible.",
		highlights: scoredRoute.reasons.slice(0, 3),
		categories: categories.slice(0, 4),
	};
}

function buildRouteSteps(route, shapeIndex = new Map()) {
	const steps = [];
	let order = 0;

	for (const leg of route.legs || []) {
		for (const step of leg.steps || []) {
			const durationMinutes = toMinutes(step.duration?.value);
			if (step.travel_mode === "WALKING") {
				const departureStop = step.transit_details?.departure_stop?.name;
				const instruction = cleanInstruction(step.html_instructions)
					|| (departureStop
						? `Marche ${durationMinutes} min jusqu’à l’arrêt ${departureStop}.`
						: `Marche ${durationMinutes} min.`);
				const startPoint = step.start_location?.lat != null && step.start_location?.lng != null
					? { lat: step.start_location.lat, lng: step.start_location.lng }
					: null;
				const endPoint = step.end_location?.lat != null && step.end_location?.lng != null
					? { lat: step.end_location.lat, lng: step.end_location.lng }
					: null;
			steps.push({
					order: order++,
					mode: "walk",
					instruction,
					durationMinutes,
					line: null,
					destination: null,
					stopName: departureStop || null,
					arrivalStopName: null,
					stopsCount: null,
					startLatitude: step.start_location?.lat ?? null,
					startLongitude: step.start_location?.lng ?? null,
					targetLatitude: step.end_location?.lat ?? null,
					targetLongitude: step.end_location?.lng ?? null,
					path: dedupeCoordinates([startPoint, endPoint].filter(Boolean)),
				});
				continue;
			}

			if (step.travel_mode === "BICYCLING") {
				const instruction = cleanInstruction(step.html_instructions) || `Pedale ${durationMinutes} min jusqu'a destination.`;
				const startPoint = step.start_location?.lat != null && step.start_location?.lng != null
					? { lat: step.start_location.lat, lng: step.start_location.lng }
					: null;
				const endPoint = step.end_location?.lat != null && step.end_location?.lng != null
					? { lat: step.end_location.lat, lng: step.end_location.lng }
					: null;
				steps.push({
					order: order++,
					mode: "bike",
					instruction,
					durationMinutes,
					line: null,
					destination: null,
					stopName: null,
					arrivalStopName: null,
					stopsCount: null,
					startLatitude: step.start_location?.lat ?? null,
					startLongitude: step.start_location?.lng ?? null,
					targetLatitude: step.end_location?.lat ?? null,
					targetLongitude: step.end_location?.lng ?? null,
					path: dedupeCoordinates([startPoint, endPoint].filter(Boolean)),
				});
				continue;
			}

			if (step.travel_mode === "TRANSIT") {
				const details = step.transit_details || {};
				const line = normalizeLine(details.line?.short_name);
				const destination = details.headsign || details.arrival_stop?.name || null;
				const departureStop = details.departure_stop?.name || null;
				const arrivalStop = details.arrival_stop?.name || null;
				const stopsCount = details.num_stops || null;
				const vehicleLabel = String(details.line?.vehicle?.name || "").toLowerCase();
				const mode = vehicleLabel.includes("subway") || vehicleLabel.includes("metro")
					? "metro"
					: vehicleLabel.includes("bus")
						? "bus"
						: "tram";
				const instruction = `Prends ${mode === "metro" ? "le métro" : mode === "bus" ? "le bus" : "le tram"} ${line} direction ${destination || "destination"}${departureStop ? ` à ${departureStop}` : ""}${arrivalStop ? `. Descends à ${arrivalStop}` : ""}.`;
				const startPoint = details.departure_stop?.location?.lat != null && details.departure_stop?.location?.lng != null
					? { lat: details.departure_stop.location.lat, lng: details.departure_stop.location.lng }
					: step.start_location?.lat != null && step.start_location?.lng != null
						? { lat: step.start_location.lat, lng: step.start_location.lng }
						: null;
				const endPoint = details.arrival_stop?.location?.lat != null && details.arrival_stop?.location?.lng != null
					? { lat: details.arrival_stop.location.lat, lng: details.arrival_stop.location.lng }
					: step.end_location?.lat != null && step.end_location?.lng != null
						? { lat: step.end_location.lat, lng: step.end_location.lng }
						: null;

				steps.push({
					order: order++,
					mode,
					instruction,
					durationMinutes,
					line,
					destination,
					stopName: departureStop,
					arrivalStopName: arrivalStop,
					stopsCount,
					startLatitude: details.departure_stop?.location?.lat ?? step.start_location?.lat ?? null,
					startLongitude: details.departure_stop?.location?.lng ?? step.start_location?.lng ?? null,
					targetLatitude: details.arrival_stop?.location?.lat ?? step.end_location?.lat ?? null,
					targetLongitude: details.arrival_stop?.location?.lng ?? step.end_location?.lng ?? null,
					path: buildStepPathFromShape(line, startPoint, endPoint, shapeIndex),
				});
			}
		}
	}

	return steps;
}

function scoreSingleRoute(route, context, weights = DEFAULT_WEIGHTS) {
	const totalDurationSeconds = routeTotalDuration(route);
	const walkingDurationSeconds = routeWalkDuration(route);
	const bikingDurationSeconds = routeBikeDuration(route);
	const transfers = routeTransfers(route);
	const lines = [...new Set(extractTransitLines(route))];
	const primaryMode = routePrimaryMode(route);
	const stopNames = collectTransitStops(route);
	const transferStops = collectTransferStops(route);
	const routeCoords = extractRouteCoordinates(route);
	const shapeIndex = buildShapeIndex(context.shapeFiles);
	const blockedLines = lines.filter((line) => context.blockedLines.includes(line));

	const incidents = context.incidents.filter((incident) => {
		if (blockedLines.includes(normalizeLine(incident.line))) return true;
		if (lines.includes(normalizeLine(incident.line))) return true;
		const incidentStop = incident.stop?.name;
		return incidentStop && stopNames.some((name) => {
			const normalizedName = String(name).toLowerCase();
			const normalizedIncidentStop = String(incidentStop).toLowerCase();
			return normalizedName.includes(normalizedIncidentStop) || normalizedIncidentStop.includes(normalizedName);
		});
	});

	const waitingStats = computeWaitingStats(lines, context.departures);
	const incidentPenalty = computeIncidentPenalty(incidents);
	const corridorGeographicPenalty = computeCorridorGeographicPenalty(routeCoords, incidents);
	const corridorShapePenalty = computeShapeCorridorPenalty(lines, shapeIndex, incidents);
	const transferFragility = computeTransferFragility(transferStops, incidents);
	const stopFragility =
		computeStopFragility(stopNames, incidents)
		+ computeHistoricalStopFragility(stopNames, context.fragilitySnapshots, context.requestDate, lines);
	const walkingMinutes = toMinutes(walkingDurationSeconds);
	const bikingMinutes = toMinutes(bikingDurationSeconds);
	const totalDurationMinutes = toMinutes(totalDurationSeconds);
	const activeModePenalty = activeModeDurationPenalty({ primaryMode, totalDurationMinutes });

	const score =
		(totalDurationSeconds / 60) * weights.duration +
		walkingMinutes * weights.walking +
		bikingMinutes * 0.65 +
		transfers * weights.transfers +
		waitingStats.averageWait * weights.waitingAverage +
		waitingStats.variance * weights.waitingVariance +
		incidentPenalty * weights.corridorIncident +
		corridorGeographicPenalty * weights.corridorGeographic +
		corridorShapePenalty * weights.corridorShape +
		transferFragility * weights.transferFragility +
		stopFragility * weights.stopFragility +
		blockedLines.length * weights.blockedLine +
		activeModePenalty;

	const severityInfo = summarizeSeverity(incidents);
	const reasons = buildReasons({
		incidentPenalty,
		corridorGeographicPenalty,
		corridorShapePenalty,
		transferFragility,
		stopFragility,
		waitingStats,
		blockedLines,
		walkingMinutes,
		primaryMode,
		totalDurationMinutes,
	});
	const steps = buildRouteSteps(route, shapeIndex);

	return {
		route,
		score,
		totalDurationSeconds,
		walkingDurationSeconds,
		bikingDurationSeconds,
		transfers,
		lines,
		primaryMode,
		incidents,
		severity: severityInfo.severity,
		confidence: severityInfo.confidence,
		averageWait: waitingStats.averageWait,
		waitingVariance: waitingStats.variance,
		corridorGeographicPenalty,
		corridorShapePenalty,
		stopFragility,
		transferFragility,
		blockedLines,
		activeModePenalty,
		reasons,
		steps,
	};
}

function buildExplanation(scoredRoute, label) {
	if (scoredRoute.primaryMode === "bike") {
		return `${label}. Ce trajet a velo reduit la dependance au reseau STIB tout en restant direct.`;
	}

	if (scoredRoute.primaryMode === "walk") {
		return `${label}. Ce trajet a pied permet d'eviter le reseau STIB sur une distance encore raisonnable.`;
	}

	if (!scoredRoute.incidents.length) {
		return `${label}. Aucun incident fort n’est détecté sur ce corridor et l’attente paraît stable.`;
	}

	const reasons = scoredRoute.reasons.slice(0, 2);
	if (!reasons.length) {
		return `${label}. Cet itinéraire limite mieux les perturbations et les attentes instables.`;
	}

	return `${label}. ${reasons.join(" ")}`;
}

function dedupeByRoute(items) {
	const seen = new Set();
	return items.filter((item) => {
		const key = item.data?.lines?.join("|") + "|" + item.data?.totalDurationSeconds + "|" + item.data?.walkingDurationSeconds;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function scoreRoutes({ routes, incidents, departures, lignesBloquees = [], shapeFiles = [], fragilitySnapshots = [], requestDate = new Date() }) {
	const blockedLines = lignesBloquees.map(normalizeLine).filter(Boolean);
	const scored = routes
		.map((route) => scoreSingleRoute(route, { incidents, departures, blockedLines, shapeFiles, fragilitySnapshots, requestDate }))
		.sort((a, b) => a.score - b.score);

	if (!scored.length) {
		return { scoredRoutes: [], alternatives: [], severity: SEVERITY.MINOR, confidence: 0.55 };
	}

	const bestOverall = scored[0];
	const bestTransitRoute = scored.find((item) => item.primaryMode === "transit");
	const fastest = scored.slice().sort((a, b) => a.totalDurationSeconds - b.totalDurationSeconds)[0];
	const leastWalking = scored.slice().sort((a, b) => a.walkingDurationSeconds - b.walkingDurationSeconds)[0];
	const bikeRouteCandidate = scored.find((item) => item.primaryMode === "bike");
	const walkRouteCandidate = scored.find((item) => item.primaryMode === "walk");
	const bikeRoute = shouldExposeBikeAlternative(bikeRouteCandidate, bestTransitRoute) ? bikeRouteCandidate : null;
	const walkRoute = shouldExposeWalkAlternative(walkRouteCandidate, bestTransitRoute) ? walkRouteCandidate : null;
	const mostReliable = scored.slice().sort((a, b) => {
		const reliabilityA = a.incidents.length * 8 + a.waitingVariance * 2.4 + a.transferFragility * 2 + a.corridorGeographicPenalty * 1.8 + a.stopFragility * 1.6;
		const reliabilityB = b.incidents.length * 8 + b.waitingVariance * 2.4 + b.transferFragility * 2 + b.corridorGeographicPenalty * 1.8 + b.stopFragility * 1.6;
		return reliabilityA - reliabilityB || a.score - b.score;
	})[0];

	const alternatives = dedupeByRoute([
		{ type: "best_overall", label: "Meilleur compromis", data: bestOverall },
		{ type: "most_reliable", label: "Plus fiable", data: mostReliable },
		{ type: "fastest", label: "Plus rapide", data: fastest },
		{ type: "least_walking", label: "Moins de marche", data: leastWalking },
		...(bikeRoute ? [{ type: "bike", label: "Alternative velo", data: bikeRoute }] : []),
		...(walkRoute ? [{ type: "walk", label: "Alternative a pied", data: walkRoute }] : []),
		...scored.slice(1, 3).map((item, index) => ({
			type: `alternative_${index + 1}`,
			label: `Alternative ${index + 1}`,
			data: item,
		})),
	]).map((entry) => ({
		type: entry.type,
		label: entry.label,
		score: Number(entry.data.score.toFixed(2)),
		totalDurationMinutes: toMinutes(entry.data.totalDurationSeconds),
		walkingMinutes: toMinutes(entry.data.walkingDurationSeconds),
		transfers: entry.data.transfers,
		lines: entry.data.lines,
		severity: entry.data.severity,
		confidence: entry.data.confidence,
		explanation: buildExplanation(entry.data, entry.label),
		explanationDetails: buildExplanationDetails(entry.data),
		reasons: entry.data.reasons,
		steps: entry.data.steps,
	}));

	return {
		scoredRoutes: scored,
		alternatives,
		severity: bestOverall.severity,
		confidence: bestOverall.confidence,
	};
}

module.exports = {
	scoreRoutes,
};
