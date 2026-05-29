const express = require("express");
const {
	voirShapeFiles,
	voirStopDetails,
	voirTravellersInformation,
	voirWaitingTimes,
	voirVehiclePositions,
	voirVehiclePositionsMap,
} = require("../controllers/stibRealtimeController");
const { getFullStopSchedule } = require("../services/staticTimetableService");

const router = express.Router();

router.get("/travellers-information", voirTravellersInformation);
router.get("/waiting-times", voirWaitingTimes);
router.get("/vehicle-positions", voirVehiclePositions);
router.get("/vehicle-positions-map", voirVehiclePositionsMap);
router.get("/shape-files", voirShapeFiles);
router.get("/stop-details", voirStopDetails);

// Horaires théoriques d'un arrêt STIB (GTFS static), groupés par
// ligne+direction+dayType. Source : backend/data/theoretical-schedules
// (21 parts JSON snapshot du GTFS officiel mai 2026).
router.get("/schedule/:stopId", async (req, res) => {
	try {
		const data = await getFullStopSchedule(req.params.stopId);
		res.json({ stopId: req.params.stopId, lines: data });
	} catch (error) {
		console.error("[stib.schedule]", error);
		res.status(500).json({ message: "Erreur chargement horaires.", error: error.message });
	}
});

module.exports = router;
