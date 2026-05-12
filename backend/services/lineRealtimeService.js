const Ligne = require("../models/Ligne");
const Arret = require("../models/Arret");
const { getVehiclePositions, getWaitingTimes } = require("./belgianMobility");

const EARTH_RADIUS_M = 6_371_000;

function toRad(deg) {
	return (deg * Math.PI) / 180;
}

function haversineMeters(lat1, lng1, lat2, lng2) {
	if ([lat1, lng1, lat2, lng2].some((v) => v == null || Number.isNaN(v))) return null;
	const dLat = toRad(lat2 - lat1);
	const dLng = toRad(lng2 - lng1);
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
	return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

// Given an ordered list of stops with coords, finds the position of a vehicle
// on the line as a fractional stop index. Used to render the vehicle dot
// between two stops on the visualizer.
function vehicleProgressOnLine(stops, vehicleLat, vehicleLng) {
	if (!Array.isArray(stops) || stops.length < 2) return null;
	if (vehicleLat == null || vehicleLng == null) return null;

	// Find the nearest segment (stop[i] → stop[i+1]) and project vehicle onto it.
	let bestProgress = null;
	let bestDistance = Infinity;
	let nearestStopIndex = 0;
	let nearestStopDistance = Infinity;

	for (let i = 0; i < stops.length; i++) {
		const stop = stops[i];
		if (stop.latitude == null || stop.longitude == null) continue;
		const d = haversineMeters(stop.latitude, stop.longitude, vehicleLat, vehicleLng);
		if (d != null && d < nearestStopDistance) {
			nearestStopDistance = d;
			nearestStopIndex = i;
		}
	}

	// Decide which segment the vehicle is on by comparing distances to neighbors.
	const i = nearestStopIndex;
	const prev = stops[i - 1] || null;
	const curr = stops[i];
	const next = stops[i + 1] || null;

	const dPrev = prev ? haversineMeters(prev.latitude, prev.longitude, vehicleLat, vehicleLng) : Infinity;
	const dCurr = nearestStopDistance;
	const dNext = next ? haversineMeters(next.latitude, next.longitude, vehicleLat, vehicleLng) : Infinity;

	// Vehicle is in the segment that gives the smaller "between-stops" distance.
	if (next && dNext < dPrev) {
		// In segment curr → next
		const segLen = haversineMeters(curr.latitude, curr.longitude, next.latitude, next.longitude);
		const ratio = segLen ? Math.min(1, Math.max(0, 1 - dNext / (segLen + dCurr))) : 0;
		bestProgress = i + ratio;
		bestDistance = Math.min(dCurr, dNext);
	} else if (prev && dPrev < dNext) {
		// In segment prev → curr
		const segLen = haversineMeters(prev.latitude, prev.longitude, curr.latitude, curr.longitude);
		const ratio = segLen ? Math.min(1, Math.max(0, 1 - dCurr / (segLen + dPrev))) : 0;
		bestProgress = (i - 1) + ratio;
		bestDistance = Math.min(dCurr, dPrev);
	} else {
		bestProgress = i;
		bestDistance = dCurr;
	}

	return {
		stopIndex: bestProgress,
		nearestStopIndex: i,
		distanceToNearestStopMeters: Math.round(nearestStopDistance),
	};
}

async function getOrderedStopsForLine(lineId, { direction = null, destination = null } = {}) {
	const query = { lineid: String(lineId) };
	if (direction) query.direction = direction;

	let ligne = await Ligne.findOne(query).lean();
	if (!ligne) {
		// Try without direction filter if not found
		ligne = await Ligne.findOne({ lineid: String(lineId) }).lean();
	}
	if (!ligne || !Array.isArray(ligne.points) || ligne.points.length === 0) return null;

	const sortedPoints = [...ligne.points].sort((a, b) => (a.order || 0) - (b.order || 0));
	const arretIds = sortedPoints.map((p) => p.id);
	const arrets = await Arret.find({ _id: { $in: arretIds } })
		.select("_id stop_id nom latitude longitude")
		.lean();

	const arretMap = new Map(arrets.map((a) => [String(a._id), a]));

	const stops = sortedPoints
		.map((p, idx) => {
			const arret = arretMap.get(String(p.id));
			if (!arret) return null;
			return {
				order: p.order || idx + 1,
				arretId: String(arret._id),
				stopId: arret.stop_id,
				name: arret.nom,
				latitude: arret.latitude,
				longitude: arret.longitude,
			};
		})
		.filter(Boolean);

	return {
		lineId: ligne.lineid,
		direction: ligne.direction,
		destination: ligne.destination?.fr || ligne.destination?.nl || null,
		typeTransport: ligne.typeTransport,
		couleur: ligne.couleur,
		stops,
	};
}

async function getLineRealtime({ lineId, userStopId = null, maxVehicles = 3 }) {
	if (!lineId) throw new Error("lineId required");

	const lineData = await getOrderedStopsForLine(lineId);
	if (!lineData || lineData.stops.length === 0) {
		return {
			lineId,
			error: "line_unknown",
			stops: [],
			vehicles: [],
			userStopOrder: null,
		};
	}

	const { stops } = lineData;

	let userStopOrder = null;
	let userStopIndex = -1;
	if (userStopId) {
		const userStopStr = String(userStopId);
		userStopIndex = stops.findIndex(
			(s) => s.arretId === userStopStr || s.stopId === userStopStr
		);
		if (userStopIndex >= 0) {
			userStopOrder = stops[userStopIndex].order;
		}
	}

	let vehicles = [];
	try {
		const result = await getVehiclePositions({ line: String(lineId) });
		const items = Array.isArray(result?.items) ? result.items : [];
		vehicles = items
			.filter((v) => v.latitude != null && v.longitude != null)
			.map((v) => {
				const progress = vehicleProgressOnLine(stops, Number(v.latitude), Number(v.longitude));
				return {
					vehicleId: v.vehicleId,
					direction: v.direction,
					latitude: Number(v.latitude),
					longitude: Number(v.longitude),
					updatedAt: v.updatedAt,
					stopIndex: progress?.stopIndex ?? null,
					nearestStopIndex: progress?.nearestStopIndex ?? null,
					distanceToNearestStopMeters: progress?.distanceToNearestStopMeters ?? null,
				};
			});
	} catch (e) {
		console.warn("[lineRealtime] vehicle positions failed:", e.message);
	}

	// Filter vehicles still approaching the user's stop (positive direction)
	if (userStopIndex >= 0) {
		vehicles = vehicles
			.filter((v) => v.stopIndex != null && v.stopIndex <= userStopIndex + 0.05)
			.sort((a, b) => (b.stopIndex || 0) - (a.stopIndex || 0))
			.slice(0, maxVehicles);
	} else {
		vehicles = vehicles
			.sort((a, b) => (a.stopIndex || 0) - (b.stopIndex || 0))
			.slice(0, maxVehicles);
	}

	let etaMinutes = null;
	let etaDestination = null;
	let etaDelayMinutes = null;
	if (userStopId) {
		try {
			const wt = await getWaitingTimes({ stopId: userStopId, line: String(lineId) });
			const matching = (wt.items || []).filter((entry) => {
				const wtLine = String(entry.line || "").toLowerCase();
				return wtLine === String(lineId).toLowerCase();
			});
			if (matching.length > 0) {
				const first = matching[0];
				etaMinutes = Number.isFinite(first.minutes) ? first.minutes : null;
				etaDestination = first.destination || null;
				if (matching.length > 1) {
					// Second-arrival info could go here in the future.
				}
			}
		} catch (e) {
			console.warn("[lineRealtime] waiting times failed:", e.message);
		}
	}

	for (const v of vehicles) {
		if (userStopIndex >= 0 && v.stopIndex != null) {
			v.stopsAway = Math.max(0, userStopIndex - v.stopIndex);
		} else {
			v.stopsAway = null;
		}
	}

	return {
		lineId: lineData.lineId,
		typeTransport: lineData.typeTransport,
		couleur: lineData.couleur,
		direction: lineData.direction,
		destination: lineData.destination,
		stops: stops.map((s) => ({
			order: s.order,
			arretId: s.arretId,
			stopId: s.stopId,
			name: s.name,
			latitude: s.latitude,
			longitude: s.longitude,
			isUserStop: userStopIndex >= 0 && s.order === userStopOrder,
		})),
		vehicles,
		userStopOrder,
		etaAtUserStop: etaMinutes != null ? {
			minutes: etaMinutes,
			destination: etaDestination,
			delayMinutes: etaDelayMinutes,
		} : null,
		fetchedAt: new Date().toISOString(),
	};
}

module.exports = {
	getLineRealtime,
	getOrderedStopsForLine,
	vehicleProgressOnLine,
};
