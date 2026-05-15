const fs = require("fs");
const os = require("os");
const path = require("path");
require("dotenv").config();

const connectDB = require("../config/db");
const Arret = require("../models/Arret");
const Ligne = require("../models/Ligne");

function expandHome(inputPath) {
	if (!inputPath) return inputPath;
	if (inputPath.startsWith("~/")) {
		return path.join(os.homedir(), inputPath.slice(2));
	}
	return inputPath;
}

function resolveCatalogPath() {
	const candidates = [
		process.argv[2],
		process.env.STIB_STATIC_CATALOG_PATH,
		path.resolve(__dirname, "../data/stib-static-catalog-merged.json"),
		path.resolve(__dirname, "../../StibAlert-main/StibAlert/Resources/stib-static-catalog-merged.json"),
		path.join(os.homedir(), "Downloads", "stib-static-catalog-merged.json"),
	]
		.filter(Boolean)
		.map(expandHome);

	return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function normalizeTransportType(rawType) {
	switch (String(rawType || "").trim().toLowerCase()) {
	case "tram":
		return "Tram";
	case "bus":
		return "Bus";
	case "metro":
	case "métro":
		return "Métro";
	default:
		return "Bus";
	}
}

function chunk(items, size = 250) {
	const chunks = [];
	for (let index = 0; index < items.length; index += size) {
		chunks.push(items.slice(index, index + size));
	}
	return chunks;
}

function buildStopMetadata(linesByKey) {
	const stopTransports = new Map();
	const stopOrders = new Map();

	for (const [variantKey, line] of Object.entries(linesByKey || {})) {
		const baseLineId = String(line.lineId || variantKey).split(":")[0];
		const mappedType = normalizeTransportType(line.typeTransport);
		for (const stop of line.stops || []) {
			const stopKey = String(stop.mergedStopId);
			if (!stopTransports.has(stopKey)) {
				stopTransports.set(stopKey, new Set());
			}
			stopTransports.get(stopKey).add(mappedType);

			if (!stopOrders.has(stopKey)) {
				stopOrders.set(stopKey, {});
			}
			const currentOrder = stopOrders.get(stopKey)[baseLineId];
			if (currentOrder == null || stop.order < currentOrder) {
				stopOrders.get(stopKey)[baseLineId] = stop.order;
			}
		}
	}

	return { stopTransports, stopOrders };
}

function buildStopOperations(catalog, datasetTag) {
	const { stopTransports, stopOrders } = buildStopMetadata(catalog.lines);

	return (catalog.stops || []).map((stop) => {
		const mergedStopId = String(stop.id);
		const physicalStopIds = Array.isArray(stop.physicalStopIds)
			? [...new Set(stop.physicalStopIds.map(String).filter(Boolean))]
			: [];
		const realtimeStopId = physicalStopIds[0] || `MERGED-${mergedStopId}`;
		const lignesDesservies = [...new Set((stop.lines || []).map((line) => String(line).split(":")[0]).filter(Boolean))];
		const typeTransport = [...(stopTransports.get(mergedStopId) || new Set())];
		const order = stopOrders.get(mergedStopId) || {};

		return {
			updateOne: {
				filter: {
					$or: [{ merged_stop_id: mergedStopId }, { stop_id: realtimeStopId }],
				},
				update: {
					$set: {
						stop_id: realtimeStopId,
						merged_stop_id: mergedStopId,
						nom: stop.nameFr,
						latitude: stop.latitude,
						longitude: stop.longitude,
						physicalStopIds,
						typeTransport,
						lignesDesservies,
						order,
						sourceDataset: datasetTag,
					},
				},
				upsert: true,
			},
		};
	});
}

function buildLineDocument({ variantKey, line, stopIdByMergedId, datasetTag }) {
	const orderedStops = [...(line.stops || [])].sort((left, right) => left.order - right.order);
	const points = orderedStops
		.map((stop) => {
			const arretId = stopIdByMergedId.get(String(stop.mergedStopId));
			if (!arretId) return null;
			return { id: arretId, order: stop.order };
		})
		.filter(Boolean);

	const firstStop = orderedStops[0];
	const lastStop = orderedStops[orderedStops.length - 1];
	const destinationFr = line.destinationFr || lastStop?.nameFr || firstStop?.nameFr || String(line.lineId);
	const destinationNl = line.destinationNl || lastStop?.nameNl || destinationFr;

	return {
		lineid: variantKey,
		nomComplet: firstStop?.nameFr || destinationFr,
		nomCompletRetour: lastStop?.nameFr || destinationFr,
		typeTransport: normalizeTransportType(line.typeTransport),
		couleur: line.colorHex || "#000000",
		destination: {
			fr: destinationFr,
			nl: destinationNl,
		},
		direction: line.direction === "Suburb" ? "Suburb" : "City",
		points,
		sourceDataset: datasetTag,
	};
}

function buildLineOperations(catalog, stopIdByMergedId, datasetTag) {
	return Object.entries(catalog.lines || {}).map(([variantKey, line]) => ({
		replaceOne: {
			filter: { lineid: variantKey },
			replacement: buildLineDocument({ variantKey, line, stopIdByMergedId, datasetTag }),
			upsert: true,
		},
	}));
}

async function executeBulk(model, operations, label) {
	for (const part of chunk(operations, 250)) {
		if (!part.length) continue;
		await model.bulkWrite(part, { ordered: false });
	}
	console.log(`✅ ${label}: ${operations.length}`);
}

async function removeStaleStaticData(catalog) {
	const variantKeys = Object.keys(catalog.lines || {});
	const mergedStopIds = (catalog.stops || []).map((stop) => String(stop.id));

	const staleLines = await Ligne.find({ lineid: { $nin: variantKeys } }).select("_id lineid").lean();
	if (staleLines.length) {
		await Ligne.deleteMany({ _id: { $in: staleLines.map((line) => line._id) } });
		console.log(`🧹 Lignes obsolètes supprimées: ${staleLines.length}`);
	}

	const staleStops = await Arret.find({
		merged_stop_id: { $exists: true, $nin: mergedStopIds },
	})
		.select("_id")
		.lean();

	if (staleStops.length) {
		await Arret.deleteMany({ _id: { $in: staleStops.map((stop) => stop._id) } });
		console.log(`🧹 Arrêts statiques obsolètes supprimés: ${staleStops.length}`);
	}
}

/**
 * Imports the STIB static catalog. Idempotent (upserts). Returns counts.
 * - skipDbConnect: pass true if the caller already opened the Mongo connection
 *   (so we don't re-open and we don't exit the process).
 */
async function importStaticCatalog({ skipDbConnect = false } = {}) {
	const catalogPath = resolveCatalogPath();
	if (!catalogPath) {
		throw new Error("Fichier stib-static-catalog-merged.json introuvable.");
	}

	const raw = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
	if (!Array.isArray(raw.stops) || !raw.lines || typeof raw.lines !== "object") {
		throw new Error("Le catalogue STIB fusionné est invalide.");
	}

	if (!skipDbConnect) {
		const isConnected = await connectDB();
		if (!isConnected) {
			throw new Error("Connexion MongoDB impossible.");
		}
	}

	const datasetTag = `stib-static-catalog:${raw.generatedAt || new Date().toISOString()}`;

	console.log(`🚀 Import catalogue STIB depuis ${catalogPath}`);
	console.log(`   Stops: ${raw.stops.length}`);
	console.log(`   Variantes de lignes: ${Object.keys(raw.lines).length}`);

	const stopOperations = buildStopOperations(raw, datasetTag);
	await executeBulk(Arret, stopOperations, "Arrêts upserted");

	const importedStops = await Arret.find({
		merged_stop_id: { $in: raw.stops.map((stop) => String(stop.id)) },
	})
		.select("_id merged_stop_id")
		.lean();

	const stopIdByMergedId = new Map(importedStops.map((stop) => [String(stop.merged_stop_id), stop._id]));
	const lineOperations = buildLineOperations(raw, stopIdByMergedId, datasetTag);
	await executeBulk(Ligne, lineOperations, "Lignes upserted");
	await removeStaleStaticData(raw);

	console.log("🎯 Import STIB statique terminé.");
	return {
		stops: stopOperations.length,
		lines: lineOperations.length,
		catalogPath,
	};
}

module.exports = { importStaticCatalog };

if (require.main === module) {
	importStaticCatalog()
		.then(() => process.exit(0))
		.catch((error) => {
			console.error("❌ Import STIB statique impossible:", error);
			process.exit(1);
		});
}
