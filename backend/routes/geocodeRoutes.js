const express = require("express");
const router = express.Router();
const geocodeController = require("../controllers/geocodeController");

router.get("/", geocodeController.geocode);

module.exports = router;
