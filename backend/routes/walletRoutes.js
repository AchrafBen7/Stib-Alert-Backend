const express = require("express");
const router = express.Router();
const walletController = require("../controllers/walletController");
const protect = require("../middlewares/authMiddleware");

router.post("/mobib-pass", protect, walletController.generateMobibPass);

module.exports = router;
