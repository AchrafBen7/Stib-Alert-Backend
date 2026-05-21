const express = require("express");
const { nextDepartures } = require("../services/nmbsScheduleService");

const router = express.Router();

// GET /api/sncb/departures?stationId=gs:nmbssncb:S8811106&limit=8
// Next theoretical departures (static GTFS) from now for a gare. No live data.
router.get("/departures", (req, res) => {
	const stationId = String(req.query.stationId || "").trim();
	if (!stationId) {
		return res.status(400).json({ message: "stationId requis." });
	}
	const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 8, 1), 20);
	res.json(nextDepartures(stationId, limit));
});

module.exports = router;
