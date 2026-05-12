const express = require("express");
const router = express.Router();
const moderationController = require("../controllers/moderationController");
const protect = require("../middlewares/authMiddleware");
const isAdmin = require("../middlewares/adminMiddleware");

router.get("/queue", protect, isAdmin, moderationController.getQueue);
router.get("/summary", protect, isAdmin, moderationController.getSummary);
router.post("/:flagId/action", protect, isAdmin, moderationController.actionFlag);

module.exports = router;
