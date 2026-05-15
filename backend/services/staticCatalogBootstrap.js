const Arret = require("../models/Arret");
const Ligne = require("../models/Ligne");
const logger = require("./logger");

const MIN_STOPS_THRESHOLD = parseInt(process.env.STATIC_CATALOG_MIN_STOPS, 10) || 1000;
const MIN_LINES_THRESHOLD = parseInt(process.env.STATIC_CATALOG_MIN_LINES, 10) || 30;

/**
 * On fresh DB or partial seeds, the /api/transport/stop/:id and
 * /api/transport/line/:id endpoints return 404 because the STIB merged
 * catalog (~3.7k stops, ~70 line variants) was never imported.
 * This bootstrap runs the seed automatically if either collection is below a
 * sane threshold. Idempotent — uses upserts.
 */
async function bootstrapStaticCatalogIfEmpty() {
	if (process.env.STATIC_CATALOG_BOOTSTRAP === "false") {
		logger.info("[catalog-bootstrap] disabled via env, skipping");
		return { skipped: true };
	}

	try {
		const [stopCount, lineCount] = await Promise.all([
			Arret.countDocuments({ merged_stop_id: { $exists: true } }),
			Ligne.countDocuments(),
		]);

		if (stopCount >= MIN_STOPS_THRESHOLD && lineCount >= MIN_LINES_THRESHOLD) {
			logger.info("[catalog-bootstrap] catalog OK, skipping seed", {
				stopCount,
				lineCount,
			});
			return { skipped: true, stopCount, lineCount };
		}

		logger.warn("[catalog-bootstrap] catalog below threshold, running import", {
			stopCount,
			lineCount,
			minStops: MIN_STOPS_THRESHOLD,
			minLines: MIN_LINES_THRESHOLD,
		});

		const { importStaticCatalog } = require("../scripts/importStaticCatalog");
		const result = await importStaticCatalog({ skipDbConnect: true });

		logger.info("[catalog-bootstrap] import complete", {
			stops: result.stops,
			lines: result.lines,
		});
		return { imported: true, ...result };
	} catch (error) {
		logger.error("[catalog-bootstrap] import failed", {
			error: error.message,
		});
		return { error: error.message };
	}
}

module.exports = { bootstrapStaticCatalogIfEmpty };
