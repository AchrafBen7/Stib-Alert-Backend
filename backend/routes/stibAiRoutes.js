const express = require("express");
const stibAiController = require("../controllers/stibAiController");

const router = express.Router();

router.post("/", stibAiController.streamChat);

module.exports = router;
