const fs = require("fs");
const path = require("path");

// De Lijn (~30k stops) and TEC (~31k stops) are far too large to ship to the
// app like the 591 SNCB gares. Instead the backend keeps the compact stop
// datasets in memory and serves only the stops inside the current map viewport
// — so the app receives a few hundred at most, and only once the user has
// zoomed in. Lines + official disruptions are small and served whole.
const DATA_DIR = path.join(__dirname, "..", "data");
const OPERATORS = new Set(["delijn", "tec"]);

const cache = {}; // op -> { stops, lines, disruptions }

function loadJSON(file, fallback) {
	try {
		return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), "utf8"));
	} catch (error) {
		console.warn(`[operators] dataset unavailable: ${file} (${error.message})`);
		return fallback;
	}
}

function bundle(op) {
	if (cache[op]) return cache[op];
	// disruptions ne sont plus servies depuis un snapshot statique : la voie
	// nominale passe désormais par delijnLiveService / tecLiveService dans
	// operatorRoutes.js. Si l'API live échoue, on retourne une liste vide
	// plutôt que des fausses alertes périmées de 2024.
	cache[op] = {
		stops: loadJSON(`${op}-stops.json`, { stops: [] }).stops || [],
		lines: loadJSON(`${op}-lines.json`, []),
		disruptions: [],
	};
	return cache[op];
}

// Stops stored compact as { i:id, n:name, y:lat, x:lng }.
function stopsInViewport(op, bbox, limit = 250) {
	if (!OPERATORS.has(op)) return [];
	const { minLat, maxLat, minLng, maxLng } = bbox;
	const all = bundle(op).stops;
	const out = [];
	for (const s of all) {
		if (s.y >= minLat && s.y <= maxLat && s.x >= minLng && s.x <= maxLng) {
			out.push({ id: s.i, name: s.n, lat: s.y, lng: s.x });
			if (out.length >= limit) break;
		}
	}
	return out;
}

function lines(op) {
	return OPERATORS.has(op) ? bundle(op).lines : [];
}

function disruptions(op) {
	return OPERATORS.has(op) ? bundle(op).disruptions : [];
}

module.exports = { OPERATORS, stopsInViewport, lines, disruptions };
