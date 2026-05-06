// Maps STIB pointId → { lat, lng, name } using the stopDetails static dataset.
// Cached in memory for 6 hours — stop locations are static.

let pointIndex = null;
let pointIndexExpiry = 0;

async function buildPointIndex() {
    const baseUrl = (process.env.BELGIAN_MOBILITY_API_BASE_URL || "").replace(/\/+$/, "");
    const apiKey = process.env.BELGIAN_MOBILITY_API_KEY;
    const apiHeader = process.env.BELGIAN_MOBILITY_API_KEY_HEADER || "bmc-partner-key";

    const index = new Map();
    let offset = 0;

    while (true) {
        const url = `${baseUrl}/api/datasets/stibmivb/static/stopDetails/?limit=1000&offset=${offset}`;
        const res = await fetch(url, { headers: { [apiHeader]: apiKey } });
        if (!res.ok) break;

        const data = await res.json();
        const results = data?.results || [];

        for (const r of results) {
            try {
                const coords = typeof r.gpscoordinates === "string"
                    ? JSON.parse(r.gpscoordinates)
                    : r.gpscoordinates;
                if (!coords?.latitude || !coords?.longitude) continue;

                const nameRaw = typeof r.name === "string" ? JSON.parse(r.name) : r.name;
                const name = nameRaw?.fr || nameRaw?.nl || String(r.id);

                index.set(String(r.id), {
                    lat: Number(coords.latitude),
                    lng: Number(coords.longitude),
                    name,
                });
            } catch {
                // skip malformed entry
            }
        }

        if (results.length < 1000) break;
        offset += 1000;
    }

    return index;
}

async function getPointIndex() {
    if (pointIndex && Date.now() < pointIndexExpiry) return pointIndex;

    pointIndex = await buildPointIndex();
    pointIndexExpiry = Date.now() + 6 * 60 * 60 * 1000;
    console.log(`[vehicleMap] Stop index built: ${pointIndex.size} points`);
    return pointIndex;
}

// Parses STIB raw vehicle position results and enriches with GPS coordinates.
async function enrichVehiclePositions(rawResults, { lat, lng, rayon, lines } = {}) {
    const index = await getPointIndex();
    const lineFilter = lines
        ? new Set(String(lines).split(",").map((l) => l.trim().toUpperCase()))
        : null;

    const seen = new Set();
    const vehicles = [];

    for (const result of rawResults) {
        const lineId = String(result.lineid || result.lineId || result.line || "").toUpperCase();
        if (!lineId) continue;
        if (lineFilter && !lineFilter.has(lineId)) continue;

        let positions;
        try {
            const raw = result.vehiclepositions || result.positions;
            positions = typeof raw === "string" ? JSON.parse(raw) : (Array.isArray(raw) ? raw : []);
        } catch {
            continue;
        }

        for (const pos of positions) {
            const pointId = String(pos.pointId || pos.point_id || "");
            if (!pointId) continue;

            const stop = index.get(pointId);
            if (!stop) continue; // point not in static dataset — skip

            const key = `${lineId}:${pointId}:${pos.directionId || ""}`;
            if (seen.has(key)) continue;
            seen.add(key);

            vehicles.push({
                vehicleId: key,
                line: lineId,
                direction: pos.directionId ? String(pos.directionId) : null,
                latitude: stop.lat,
                longitude: stop.lng,
                distanceFromPoint: pos.distanceFromPoint ?? 0,
                stopNom: stop.name,
                updatedAt: new Date().toISOString(),
            });
        }
    }

    // Proximity filter — optional
    if (lat != null && lng != null) {
        const lat0 = parseFloat(lat);
        const lng0 = parseFloat(lng);
        const r = parseFloat(rayon) || 1;

        return vehicles.filter((v) => {
            const dlat = (v.latitude - lat0) * 111;
            const dlng = (v.longitude - lng0) * 111 * Math.cos((lat0 * Math.PI) / 180);
            return Math.sqrt(dlat * dlat + dlng * dlng) <= r;
        });
    }

    return vehicles;
}

module.exports = { enrichVehiclePositions };
