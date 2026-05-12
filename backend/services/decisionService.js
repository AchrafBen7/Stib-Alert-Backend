const Cluster = require("../models/Cluster");
const Arret = require("../models/Arret");
const Utilisateur = require("../models/Utilisateur");
const { fetchItinerairesGoogle } = require("./googleDirections");

const EARTH_RADIUS_M = 6_371_000;
const NEARBY_STOP_RADIUS_M = 250;
const ROUTINE_TIME_WINDOW_MIN = 90;

function toRad(deg) {
	return (deg * Math.PI) / 180;
}

function haversineMeters(lat1, lng1, lat2, lng2) {
	const dLat = toRad(lat2 - lat1);
	const dLng = toRad(lng2 - lng1);
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(toRad(lat1)) *
			Math.cos(toRad(lat2)) *
			Math.sin(dLng / 2) ** 2;
	return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

function parseDepartureTime(str) {
	if (!str || typeof str !== "string") return null;
	const m = str.match(/^(\d{1,2}):(\d{2})$/);
	if (!m) return null;
	return { hour: Number(m[1]), minute: Number(m[2]) };
}

function minutesUntilRoutineDeparture(routine, now = new Date()) {
	if (!routine?.enabled) return null;
	const t = parseDepartureTime(routine.departureTime);
	if (!t) return null;
	const target = new Date(now);
	target.setHours(t.hour, t.minute, 0, 0);
	const diff = (target.getTime() - now.getTime()) / 60000;
	return diff;
}

function severityFromCluster(cluster) {
	if (!cluster) return "none";
	const reports = cluster.reportCount || 0;
	const confidence = cluster.confidence;
	const ageMin = cluster.lastReportedAt
		? Math.max(0, (Date.now() - new Date(cluster.lastReportedAt).getTime()) / 60000)
		: 999;

	if (cluster.resolved) return "resolved";
	if (reports >= 5 && confidence === "high" && ageMin < 30) return "critical";
	if (reports >= 4 && confidence !== "low" && ageMin < 45) return "major";
	if (reports >= 3 && ageMin < 60) return "minor";
	return "weak";
}

function severityRank(s) {
	return { resolved: -1, none: 0, weak: 1, minor: 2, major: 3, critical: 4 }[s] || 0;
}

function severityHeadline(severity, problemType, line, reports, ageMin) {
	const ageLabel =
		ageMin < 2 ? "à l'instant" : ageMin < 60 ? `il y a ${Math.round(ageMin)} min` : `il y a ${Math.round(ageMin / 60)}h`;

	switch (severity) {
	case "critical":
		return {
			headline: `Ligne ${line} fortement perturbée`,
			subhead: `${reports} signalements de ${String(problemType || "problème").toLowerCase()} ${ageLabel} — sérieux`,
		};
	case "major":
		return {
			headline: `Ligne ${line} : ${String(problemType || "perturbation").toLowerCase()}`,
			subhead: `${reports} personnes ont signalé ${ageLabel}`,
		};
	case "minor":
		return {
			headline: `Ligne ${line} : situation tendue`,
			subhead: `${reports} signalements ${ageLabel} — à surveiller`,
		};
	default:
		return {
			headline: `Ligne ${line}`,
			subhead: "Aucun signalement majeur récent",
		};
	}
}

async function findActiveClustersForUser({ favoriteLines = [], userCoord, routine }) {
	const now = new Date();
	const query = {
		status: "active",
		expiresAt: { $gt: now },
	};

	const orFilters = [];

	if (favoriteLines.length > 0) {
		orFilters.push({ ligne: { $in: favoriteLines } });
	}

	if (routine?.homeStopId) {
		orFilters.push({ arretId: routine.homeStopId });
	}
	if (routine?.workStopId) {
		orFilters.push({ arretId: routine.workStopId });
	}

	if (orFilters.length > 0) {
		query.$or = orFilters;
	}

	let clusters = await Cluster.find(query)
		.sort({ lastReportedAt: -1 })
		.limit(20)
		.populate("arretId", "nom stop_id latitude longitude")
		.lean();

	if (userCoord) {
		clusters = clusters.filter((c) => {
			if (c.latitude == null || c.longitude == null) return true;
			const d = haversineMeters(userCoord.lat, userCoord.lng, c.latitude, c.longitude);
			return d <= 1500;
		});
	}

	return clusters;
}

function pickPrimaryCluster(clusters, { routine, userCoord }) {
	if (!clusters || clusters.length === 0) return null;

	const scored = clusters.map((c) => {
		const sev = severityFromCluster(c);
		let score = severityRank(sev) * 10;

		if (routine?.homeStopId && String(c.arretId?._id || c.arretId) === String(routine.homeStopId)) {
			score += 5;
		}
		if (routine?.workStopId && String(c.arretId?._id || c.arretId) === String(routine.workStopId)) {
			score += 5;
		}

		if (userCoord && c.latitude != null && c.longitude != null) {
			const d = haversineMeters(userCoord.lat, userCoord.lng, c.latitude, c.longitude);
			if (d < 250) score += 3;
			else if (d < 500) score += 2;
			else if (d < 1000) score += 1;
		}

		return { cluster: c, severity: sev, score };
	});

	scored.sort((a, b) => b.score - a.score);
	const top = scored[0];
	if (top.score < 10) return null;
	return top;
}

async function findNearbyAlternativeStops(arret, excludeLine, { limit = 5, radiusMeters = 400 } = {}) {
	if (!arret?.latitude || !arret?.longitude) return [];

	const arrets = await Arret.find({
		latitude: { $exists: true, $ne: null },
		longitude: { $exists: true, $ne: null },
		_id: { $ne: arret._id },
	})
		.select("stop_id nom latitude longitude lignesDesservies")
		.limit(200)
		.lean();

	const enriched = arrets
		.map((a) => ({
			...a,
			distanceMeters: haversineMeters(arret.latitude, arret.longitude, a.latitude, a.longitude),
		}))
		.filter((a) => a.distanceMeters <= radiusMeters)
		.filter((a) => Array.isArray(a.lignesDesservies) && a.lignesDesservies.some((l) => l !== excludeLine))
		.sort((a, b) => a.distanceMeters - b.distanceMeters)
		.slice(0, limit);

	return enriched;
}

async function buildAlternativeRecommendation({ disruptedArret, disruptedLine, userCoord, routine }) {
	if (!disruptedArret) return null;

	const alternativeStops = await findNearbyAlternativeStops(disruptedArret, disruptedLine);
	if (alternativeStops.length === 0) {
		return {
			type: "wait",
			action: "Attendre, aucune alternative à proximité",
			reasoning: "Il n'y a pas d'autre arrêt proche desservi par une ligne utile.",
		};
	}

	const bestStop = alternativeStops[0];
	const otherLines = (bestStop.lignesDesservies || []).filter((l) => l !== disruptedLine).slice(0, 3);
	const walkMinutes = Math.max(1, Math.round(bestStop.distanceMeters / 75));

	let routeInfo = null;
	if (routine?.workStopId) {
		try {
			const workStop = await Arret.findById(routine.workStopId).lean();
			if (workStop?.latitude && workStop?.longitude) {
				const directions = await fetchItinerairesGoogle(
					`${bestStop.latitude},${bestStop.longitude}`,
					`${workStop.latitude},${workStop.longitude}`
				);
				if (Array.isArray(directions) && directions.length > 0) {
					const r = directions[0];
					routeInfo = {
						etaMinutes: r.duration_minutes || null,
						summary: r.summary || null,
					};
				}
			}
		} catch (e) {
			console.warn("[decision] alternative route fetch failed:", e.message);
		}
	}

	const action = `Marche jusqu'à ${bestStop.nom} (${Math.round(bestStop.distanceMeters)}m, ${walkMinutes} min)`;
	const reasoning = `${bestStop.nom} est desservi par les lignes ${otherLines.join(", ") || "?"} qui ne sont pas perturbées.`;

	return {
		type: "walk_and_transit",
		action,
		reasoning,
		walkToStop: {
			name: bestStop.nom,
			stopId: bestStop.stop_id,
			distanceMeters: Math.round(bestStop.distanceMeters),
			walkMinutes,
			latitude: bestStop.latitude,
			longitude: bestStop.longitude,
		},
		alternativeLines: otherLines,
		viaRoute: routeInfo,
	};
}

// ──────────────────────────────────────────────────────────────────
// TRIP-SPECIFIC DECISION
// User says "I'm here, going to X". App returns:
//  - The best route given current disruption state
//  - A warning if user's primary/fastest route uses a disrupted line
//  - A clear ranking: best (avoids disruption) vs default
// This is the ad-hoc case: no routine needed.
// ──────────────────────────────────────────────────────────────────

async function getActiveClustersGlobal() {
	const now = new Date();
	return Cluster.find({
		status: "active",
		expiresAt: { $gt: now },
	})
		.select("clusterIndex ligne arretId typeProbleme reportCount confidence lastReportedAt latitude longitude")
		.lean();
}

function routeUsesDisruptedLine(route, disruptedLines) {
	if (!route) return [];
	const hits = [];
	const steps = Array.isArray(route.steps) ? route.steps : [];
	for (const step of steps) {
		const line = step.line || step.transitLine || step.shortName;
		if (line && disruptedLines.has(String(line).toUpperCase())) {
			hits.push({ line: String(line), stepSummary: step.summary || step.instructions || null });
		}
	}
	// Also check top-level summary if line embedded as e.g. "Tram 56 vers ..."
	if (typeof route.summary === "string") {
		for (const line of disruptedLines) {
			const re = new RegExp(`\\b${line}\\b`);
			if (re.test(route.summary.toUpperCase()) && !hits.some((h) => h.line.toUpperCase() === line)) {
				hits.push({ line, stepSummary: route.summary });
			}
		}
	}
	return hits;
}

async function computeTripDecision({ userId, originCoord, destCoord, destinationLabel = null }) {
	if (!originCoord || !destCoord) {
		return {
			verdict: "ALL_CLEAR",
			headline: "Indique ta destination pour un verdict",
			subhead: null,
			generatedAt: new Date().toISOString(),
			tripMode: true,
		};
	}

	const allClusters = await getActiveClustersGlobal();
	const disruptedLines = new Set(allClusters.map((c) => String(c.ligne || "").toUpperCase()).filter(Boolean));

	let directions = [];
	try {
		directions = await fetchItinerairesGoogle(
			`${originCoord.lat},${originCoord.lng}`,
			`${destCoord.lat},${destCoord.lng}`
		);
	} catch (e) {
		console.warn("[decision.trip] Google fetch failed:", e.message);
	}

	if (!Array.isArray(directions) || directions.length === 0) {
		return {
			verdict: "WATCH",
			headline: "Pas d'itinéraire trouvé",
			subhead: "Impossible de calculer un trajet pour cette destination.",
			tripMode: true,
			generatedAt: new Date().toISOString(),
		};
	}

	const scored = directions.map((route, index) => {
		const hits = routeUsesDisruptedLine(route, disruptedLines);
		const durationMinutes = Number(route.duration_minutes || route.durationMinutes || 0);
		return {
			route,
			index,
			durationMinutes,
			disruptedLineHits: hits,
			isPerturbed: hits.length > 0,
		};
	});

	// Rank: prefer routes without perturbations; among each group, shortest duration.
	scored.sort((a, b) => {
		if (a.isPerturbed !== b.isPerturbed) return a.isPerturbed ? 1 : -1;
		return a.durationMinutes - b.durationMinutes;
	});

	const best = scored[0];
	const defaultRoute = scored.find((s) => s.index === 0) || best;
	const wasOriginalPerturbed = defaultRoute.isPerturbed;
	const bestIsCleanAlt = best.isPerturbed === false && wasOriginalPerturbed;

	const summarizeRoute = (s) => ({
		durationMinutes: s.durationMinutes,
		summary: s.route.summary || null,
		lines: Array.isArray(s.route.lines) ? s.route.lines : null,
		walkingMinutes: s.route.walkingMinutes || null,
		transferCount: s.route.transferCount ?? null,
		disruptedLines: s.disruptedLineHits.map((h) => h.line),
	});

	let verdict;
	let headline;
	let subhead;

	if (bestIsCleanAlt) {
		verdict = "AVOID";
		const disruptedLine = defaultRoute.disruptedLineHits[0]?.line || "?";
		headline = `Évite la ligne ${disruptedLine} pour ce trajet`;
		subhead = `On a trouvé une alternative qui contourne la perturbation${destinationLabel ? ` vers ${destinationLabel}` : ""}.`;
	} else if (best.isPerturbed) {
		verdict = "CAUTION";
		const lines = best.disruptedLineHits.map((h) => h.line).join(", ");
		headline = `Trajet possible mais perturbé`;
		subhead = `Toutes les routes utilisent ${lines}. Prends ton temps ou cherche un autre moyen.`;
	} else {
		verdict = "ALL_CLEAR";
		headline = destinationLabel
			? `Trajet vers ${destinationLabel} : voie libre`
			: "Trajet sans perturbation";
		subhead = `Aucune des routes proposées n'est touchée.`;
	}

	return {
		verdict,
		headline,
		subhead,
		tripMode: true,
		generatedAt: new Date().toISOString(),
		origin: originCoord,
		destination: destCoord,
		destinationLabel,
		bestRoute: summarizeRoute(best),
		defaultRoute: defaultRoute !== best ? summarizeRoute(defaultRoute) : null,
		alternatives: scored
			.slice(0, 3)
			.filter((s) => s !== best)
			.map(summarizeRoute),
		disruptedLinesInArea: Array.from(disruptedLines),
	};
}

async function computeDecision({ userId, userCoord = null, line = null }) {
	const user = userId ? await Utilisateur.findById(userId).select("favoriteLines routine").lean() : null;

	const favoriteLines = Array.isArray(user?.favoriteLines) ? user.favoriteLines : [];
	const routine = user?.routine || null;

	let scopedFavorites = favoriteLines;
	if (line) scopedFavorites = [line];

	const clusters = await findActiveClustersForUser({
		favoriteLines: scopedFavorites,
		userCoord,
		routine,
	});

	if (clusters.length === 0) {
		return {
			verdict: "ALL_CLEAR",
			headline: scopedFavorites.length > 0
				? `Tes lignes ${scopedFavorites.slice(0, 3).join(", ")} sont fluides`
				: "Aucune perturbation détectée près de toi",
			subhead: "Tu peux prendre tes lignes habituelles sans inquiétude.",
			generatedAt: new Date().toISOString(),
			affectedCluster: null,
			recommendation: null,
		};
	}

	const top = pickPrimaryCluster(clusters, { routine, userCoord });
	if (!top || top.severity === "weak" || top.severity === "resolved") {
		return {
			verdict: "WATCH",
			headline: "Quelques signalements ponctuels",
			subhead: `${clusters.length} alerte${clusters.length > 1 ? "s" : ""} active${clusters.length > 1 ? "s" : ""} mais rien de critique.`,
			generatedAt: new Date().toISOString(),
			affectedCluster: top?.cluster ? {
				clusterIndex: top.cluster.clusterIndex,
				ligne: top.cluster.ligne,
				typeProbleme: top.cluster.typeProbleme,
				reportCount: top.cluster.reportCount,
				severity: top.severity,
			} : null,
			recommendation: null,
		};
	}

	const cluster = top.cluster;
	const ageMin = cluster.lastReportedAt
		? Math.max(0, (Date.now() - new Date(cluster.lastReportedAt).getTime()) / 60000)
		: 0;

	const { headline, subhead } = severityHeadline(
		top.severity,
		cluster.typeProbleme,
		cluster.ligne,
		cluster.reportCount,
		ageMin
	);

	const recommendation = await buildAlternativeRecommendation({
		disruptedArret: cluster.arretId,
		disruptedLine: cluster.ligne,
		userCoord,
		routine,
	});

	const minutesUntilDep = minutesUntilRoutineDeparture(routine);
	const isInRoutineWindow =
		minutesUntilDep != null &&
		minutesUntilDep > -30 &&
		minutesUntilDep < ROUTINE_TIME_WINDOW_MIN;

	return {
		verdict: top.severity === "critical" ? "AVOID" : "CAUTION",
		headline,
		subhead,
		severity: top.severity,
		generatedAt: new Date().toISOString(),
		isInRoutineWindow,
		affectedCluster: {
			clusterIndex: cluster.clusterIndex,
			ligne: cluster.ligne,
			arretId: cluster.arretId?._id || cluster.arretId,
			arretNom: cluster.arretId?.nom || null,
			typeProbleme: cluster.typeProbleme,
			reportCount: cluster.reportCount,
			confidence: cluster.confidence,
			ageMinutes: Math.round(ageMin),
			latitude: cluster.latitude,
			longitude: cluster.longitude,
		},
		recommendation,
	};
}

module.exports = {
	computeDecision,
	computeTripDecision,
	findActiveClustersForUser,
	pickPrimaryCluster,
	severityFromCluster,
	haversineMeters,
};
