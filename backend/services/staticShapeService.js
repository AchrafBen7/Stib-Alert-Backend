const fs = require("fs");
const path = require("path");

const SHAPES_PATH = path.join(__dirname, "..", "shapefiles-production.json");

let cachedShapes = null;

function normalizeLine(line) {
	const raw = String(line || "").trim();
	const digits = raw.match(/\d+/)?.[0];
	if (!digits) return raw;
	return String(Number.parseInt(digits, 10));
}

function coordinatePair(pair) {
	if (!Array.isArray(pair) || pair.length < 2) return null;
	const [longitude, latitude] = pair;
	const lat = Number(latitude);
	const lng = Number(longitude);
	if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
	return [lng, lat];
}

function extractPolylines(entry) {
	const geometry = entry?.geo_shape?.geometry || entry?.geo_shape || entry?.geometry || null;
	if (!geometry) return [];

	if (geometry.type === "LineString") {
		const line = (geometry.coordinates || []).map(coordinatePair).filter(Boolean);
		return line.length > 1 ? [line] : [];
	}

	if (geometry.type === "MultiLineString") {
		return (geometry.coordinates || [])
			.map((segment) => (segment || []).map(coordinatePair).filter(Boolean))
			.filter((segment) => segment.length > 1);
	}

	return [];
}

function loadStaticShapeFiles() {
	if (cachedShapes) return cachedShapes;

	try {
		const raw = fs.readFileSync(SHAPES_PATH, "utf8");
		const entries = JSON.parse(raw);
		cachedShapes = (Array.isArray(entries) ? entries : [])
			.map((entry, index) => {
				const line = normalizeLine(entry.ligne || entry.line || entry.lineid);
				const polylines = extractPolylines(entry);
				if (!line || !polylines.length) return null;
				return {
					id: entry.id || `${line}-${entry.variante || index}`,
					line,
					transportType: entry.type || entry.transportType || null,
					direction: entry.direction || null,
					polylines,
					source: "static-shapefiles-production",
				};
			})
			.filter(Boolean);
	} catch (error) {
		console.warn("[transport] Static shape preload unavailable:", error.message);
		cachedShapes = [];
	}

	return cachedShapes;
}

function getStaticShapeFilesForLines(lines = []) {
	const wantedLines = new Set(lines.map(normalizeLine).filter(Boolean));
	if (!wantedLines.size) return [];
	return loadStaticShapeFiles().filter((shape) => wantedLines.has(normalizeLine(shape.line)));
}

module.exports = {
	getStaticShapeFilesForLines,
	loadStaticShapeFiles,
};
