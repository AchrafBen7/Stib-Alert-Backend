const express = require("express");
const transportController = require("../controllers/transportController");

const router = express.Router();

router.get("/overview", transportController.voirOverview);
router.get("/stop/:id", transportController.voirArret);
router.get("/line/:id", transportController.voirLigne);
router.post("/route/recommend", transportController.recommanderItineraire);

module.exports = router;
