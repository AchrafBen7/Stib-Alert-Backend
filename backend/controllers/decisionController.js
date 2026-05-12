const { computeDecision, computeTripDecision } = require("../services/decisionService");

function parseCoord(value) {
	if (value == null) return null;
	const n = Number(value);
	return Number.isFinite(n) ? n : null;
}

exports.getDecision = async (req, res) => {
	try {
		const userId = req.user?.userId || null;
		const lat = parseCoord(req.query.lat);
		const lng = parseCoord(req.query.lng);
		const line = req.query.ligne || req.query.line || null;

		const userCoord = lat != null && lng != null ? { lat, lng } : null;

		const destLat = parseCoord(req.query.destLat || req.query.destinationLat);
		const destLng = parseCoord(req.query.destLng || req.query.destinationLng);
		const destLabel = req.query.destLabel || req.query.destination || null;

		const destCoord = destLat != null && destLng != null ? { lat: destLat, lng: destLng } : null;

		if (destCoord && userCoord) {
			const decision = await computeTripDecision({
				userId,
				originCoord: userCoord,
				destCoord,
				destinationLabel: destLabel,
			});
			res.setHeader("Cache-Control", "private, max-age=15");
			return res.status(200).json(decision);
		}

		const decision = await computeDecision({
			userId,
			userCoord,
			line,
		});

		res.setHeader("Cache-Control", "private, max-age=20");
		return res.status(200).json(decision);
	} catch (error) {
		console.error("[decisionController.getDecision]", error);
		return res.status(500).json({
			message: "Impossible de calculer la décision.",
			error: error.message,
		});
	}
};
