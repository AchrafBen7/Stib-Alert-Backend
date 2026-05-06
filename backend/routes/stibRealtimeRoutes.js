const express = require("express");
const {
	voirShapeFiles,
	voirStopDetails,
	voirTravellersInformation,
	voirWaitingTimes,
	voirVehiclePositions,
	voirVehiclePositionsMap,
} = require("../controllers/stibRealtimeController");

const router = express.Router();

router.get("/travellers-information", voirTravellersInformation);
router.get("/waiting-times", voirWaitingTimes);
router.get("/vehicle-positions", voirVehiclePositions);
router.get("/vehicle-positions-map", voirVehiclePositionsMap);
router.get("/shape-files", voirShapeFiles);
router.get("/stop-details", voirStopDetails);

module.exports = router;
