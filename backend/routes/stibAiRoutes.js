const express = require("express");
const stibAiController = require("../controllers/stibAiController");

const router = express.Router();

router.post("/", stibAiController.streamChat);
router.post("/voice", stibAiController.voiceAsk);

module.exports = router;
