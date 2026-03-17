const express = require("express");
const {
	voirTravellersInformation,
	voirWaitingTimes,
	voirVehiclePositions,
} = require("../controllers/stibRealtimeController");

const router = express.Router();

router.get("/travellers-information", voirTravellersInformation);
router.get("/waiting-times", voirWaitingTimes);
router.get("/vehicle-positions", voirVehiclePositions);

module.exports = router;
