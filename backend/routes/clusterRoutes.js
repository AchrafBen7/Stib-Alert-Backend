const express = require("express");
const router = express.Router();
const clusterController = require("../controllers/clusterController");
const protect = require("../middlewares/authMiddleware");

router.get("/active", clusterController.listActive);
router.get("/:clusterIndex", clusterController.getDetail);
router.post("/:clusterIndex/confirm", protect.optional, clusterController.confirmStillBlocked);
router.post("/:clusterIndex/still-blocked", protect.optional, clusterController.confirmStillBlocked);
router.post("/:clusterIndex/resolve", protect.optional, clusterController.confirmResolved);
router.post("/:clusterIndex/resolved", protect.optional, clusterController.confirmResolved);

module.exports = router;
