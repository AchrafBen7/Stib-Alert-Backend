// Seeds the 50 Brussels SNCB stations into the Arret collection so they exist
// server-side from the start (instead of being lazily created on the first
// report). Keyed by the SAME stop_id slug the signalement controller uses
// (`sncb:<slug>` via ensureExternalTransportStop), so a seeded station and one
// auto-created by a report resolve to the exact same document — no duplicates.
//
// Usage:  node backend/scripts/importSncbStations.js [path-to-json]
// MONGO_URI must be set (read from .env).

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
require("dotenv").config();

const connectDB = require("../config/db");
const Arret = require("../models/Arret");

function expandHome(inputPath) {
	if (!inputPath) return inputPath;
	if (inputPath.startsWith("~/")) return path.join(os.homedir(), inputPath.slice(2));
	return inputPath;
}

function resolveJsonPath() {
	const candidates = [
		process.argv[2],
		process.env.SNCB_STATIONS_PATH,
		path.resolve(__dirname, "../data/sncb-brussels-stations.json"),
		path.resolve(__dirname, "../../StibAlert-main/StibAlert/Resources/sncb-brussels-stations.json"),
		path.join(os.homedir(), "Downloads", "sncb-brussels-stations.json"),
	]
		.filter(Boolean)
		.map(expandHome);
	return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

// Must match externalStopId() in signalementController.js exactly.
function externalStopId(name) {
	const slug = String(name || "")
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
	return `sncb:${slug || crypto.createHash("sha1").update(String(name || "unknown")).digest("hex").slice(0, 12)}`;
}

async function run() {
	const jsonPath = resolveJsonPath();
	if (!jsonPath) {
		console.error("❌ SNCB stations JSON introuvable. Donne le chemin en argument ou place-le dans backend/data/.");
		process.exit(1);
	}
	console.log(`📂 Source: ${jsonPath}`);

	const payload = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
	const stations = Array.isArray(payload) ? payload : (payload.stations || []);
	if (!stations.length) {
		console.error("❌ Aucune gare dans le JSON.");
		process.exit(1);
	}

	const connected = await connectDB();
	if (!connected) {
		console.error("❌ MongoDB indisponible (MONGO_URI ?).");
		process.exit(1);
	}

	let created = 0;
	let updated = 0;
	for (const station of stations) {
		const name = station.standardname || station.name;
		const lat = Number(station.lat);
		const lng = Number(station.lng);
		if (!name || !Number.isFinite(lat) || !Number.isFinite(lng)) {
			console.warn(`⚠️ Gare ignorée (données invalides): ${JSON.stringify(station).slice(0, 80)}`);
			continue;
		}

		const stopId = externalStopId(name);
		const result = await Arret.findOneAndUpdate(
			{ stop_id: stopId },
			{
				$setOnInsert: { stop_id: stopId, sourceDataset: "sncb-local" },
				$set: { nom: name, latitude: lat, longitude: lng },
				$addToSet: { lignesDesservies: "SNCB", typeTransport: "Train" },
			},
			{ new: true, upsert: true, rawResult: true }
		);
		if (result?.lastErrorObject?.upserted) created += 1;
		else updated += 1;
	}

	console.log(`✅ SNCB: ${created} gares créées, ${updated} mises à jour (sur ${stations.length}).`);
	process.exit(0);
}

run().catch((error) => {
	console.error("❌ Import SNCB échoué:", error.message);
	process.exit(1);
});
