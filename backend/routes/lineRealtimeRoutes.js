const express = require("express");
const router = express.Router();
const controller = require("../controllers/lineRealtimeController");

router.get("/:line/realtime", controller.getRealtime);

module.exports = router;
