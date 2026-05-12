const { getLineRealtime } = require("../services/lineRealtimeService");

exports.getRealtime = async (req, res) => {
	try {
		const lineId = req.params.line || req.query.line;
		if (!lineId) {
			return res.status(400).json({ message: "Paramètre 'line' requis." });
		}

		const userStopId = req.query.stopId || req.query.arretId || null;
		const maxVehicles = Number(req.query.maxVehicles) || 3;

		const data = await getLineRealtime({ lineId, userStopId, maxVehicles });

		res.setHeader("Cache-Control", "public, max-age=15");
		return res.status(200).json(data);
	} catch (error) {
		console.error("[lineRealtimeController.getRealtime]", error);
		return res.status(500).json({
			message: "Impossible de charger les positions temps réel.",
			error: error.message,
		});
	}
};
