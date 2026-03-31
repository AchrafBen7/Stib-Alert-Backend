const express = require("express");
const {
	voirShapeFiles,
	voirStopDetails,
	voirTravellersInformation,
	voirWaitingTimes,
	voirVehiclePositions,
} = require("../controllers/stibRealtimeController");

const router = express.Router();

router.get("/travellers-information", voirTravellersInformation);
router.get("/waiting-times", voirWaitingTimes);
router.get("/vehicle-positions", voirVehiclePositions);
router.get("/shape-files", voirShapeFiles);
router.get("/stop-details", voirStopDetails);

module.exports = router;
