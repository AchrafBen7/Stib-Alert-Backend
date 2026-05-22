const express = require("express");
const { nextDepartures, fullSchedule } = require("../services/nmbsScheduleService");

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

// GET /api/sncb/schedule?stationId=gs:nmbssncb:S8811106
// Full theoretical timetable for a gare (all 3 day-types). No live data.
router.get("/schedule", (req, res) => {
	const stationId = String(req.query.stationId || "").trim();
	if (!stationId) {
		return res.status(400).json({ message: "stationId requis." });
	}
	res.json(fullSchedule(stationId));
});

module.exports = router;
