const express = require("express");
const router = express.Router();
const signalementController = require("../controllers/signalementController");
const {
	voirSignalements,
	voterSignalement,
	voirLignesDisponibles,
	voirArretsParLigne,
	voirSignalementsParLigneEtArret,
	supprimerSignalement,
	signalerFauxSignalement,
	confirmerSignalement,
	marquerToujoursBloque,
	marquerResolu,
	upload,
} = signalementController;

const protect = require("../middlewares/authMiddleware");
const isAdmin = require("../middlewares/adminMiddleware");
const { signalementLimiter } = require("../middlewares/rateLimiters");
const {
	validateSignalement,
	validateVote,
	validateMongoId,
	handleValidation,
} = require("../middlewares/validators");

router.post(
	"/",
	protect.optional,
	signalementLimiter,
	upload.single("photo"),
	validateSignalement,
	handleValidation,
	signalementController.ajouterSignalement
);

router.get("/", voirSignalements);
router.get("/lignes", voirLignesDisponibles);
router.get("/ligne/:ligne", voirArretsParLigne);
router.get("/ligne/:ligne/arret/:arretId", voirSignalementsParLigneEtArret);

router.get("/arret/:id", validateMongoId, handleValidation, signalementController.voirSignalementsParArret);
router.get(
	"/arret/:arretId/signalement/:signalementId",
	signalementController.voirUnSignalementParArret
);

router.post("/:id/vote", protect, validateVote, handleValidation, voterSignalement);
router.post("/:id/confirm", protect, validateMongoId, handleValidation, confirmerSignalement);
router.post("/:id/still-blocked", protect, validateMongoId, handleValidation, marquerToujoursBloque);
router.post("/:id/resolved", protect, validateMongoId, handleValidation, marquerResolu);
router.post("/:id/signalement-faux", validateMongoId, handleValidation, signalerFauxSignalement);
router.get("/:id/traduire", validateMongoId, handleValidation, signalementController.traduireSignalement);

router.delete("/:id", protect, isAdmin, validateMongoId, handleValidation, supprimerSignalement);

module.exports = router;
