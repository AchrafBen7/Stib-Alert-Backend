const express = require("express");
const assistantController = require("../controllers/assistantController");
const protect = require("../middlewares/authMiddleware");

const router = express.Router();

router.get("/context", protect, assistantController.voirContext);
router.get("/home-brief", protect, assistantController.voirBriefHome);
router.post("/commute-brief", protect, assistantController.voirCommuteBrief);
router.post("/commute-email", protect, assistantController.envoyerCommuteEmail);
router.post("/commute-push", protect, assistantController.envoyerCommutePush);
router.post("/route-brief", protect, assistantController.voirBriefRoute);
router.post("/report-help", protect, assistantController.voirReportHelp);
router.post("/command", protect, assistantController.voirCommande);

module.exports = router;
