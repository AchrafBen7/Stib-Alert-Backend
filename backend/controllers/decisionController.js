const { computeDecision } = require("../services/decisionService");

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
