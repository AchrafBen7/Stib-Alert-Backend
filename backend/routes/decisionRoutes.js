const express = require("express");
const router = express.Router();
const decisionController = require("../controllers/decisionController");
const protect = require("../middlewares/authMiddleware");

router.get("/", protect.optional, decisionController.getDecision);

module.exports = router;
