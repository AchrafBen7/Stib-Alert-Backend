const express = require("express");
const router = express.Router();
const utilisateurController = require("../controllers/utilisateurController");
const {
	inscription,
	activerCompte,
	connexion,
	deconnexion,
	voirProfil,
	modifierProfil,
	voirVotesUtilisateur,
	enregistrerTokenFCM,
	voirMoi,
} = utilisateurController;

const protect = require("../middlewares/authMiddleware");
const { requireSelf } = require("../middlewares/ownership");
const { authLimiter } = require("../middlewares/rateLimiters");
const {
	validateSignup,
	validateLogin,
	validateActivation,
	validateMongoId,
	validateFavori,
	validatePushToken,
	validateProfileUpdate,
	handleValidation,
} = require("../middlewares/validators");

router.post("/inscription", authLimiter, validateSignup, handleValidation, inscription);
router.post("/activation", authLimiter, validateActivation, handleValidation, activerCompte);
router.post("/renvoyer-code", authLimiter, utilisateurController.renvoyerCode);
router.post("/connexion", authLimiter, validateLogin, handleValidation, connexion);
router.post("/deconnexion", protect, deconnexion);
router.post("/refresh", authLimiter, utilisateurController.refresh);

router.get("/me", protect, voirMoi);

router.get("/:id", protect, validateMongoId, handleValidation, requireSelf(), voirProfil);
router.patch("/:id", protect, validateMongoId, validateProfileUpdate, handleValidation, requireSelf(), modifierProfil);
router.get("/:id/votes", protect, validateMongoId, handleValidation, requireSelf(), voirVotesUtilisateur);
router.patch("/:id/langue", protect, validateMongoId, handleValidation, requireSelf(), utilisateurController.modifierLangueUtilisateur);
router.patch(
	"/:id/favoris/:arretId",
	protect,
	validateFavori,
	handleValidation,
	requireSelf(),
	utilisateurController.ajouterOuRetirerFavori
);

router.post("/enregistrer-token", protect, validatePushToken, handleValidation, enregistrerTokenFCM);

module.exports = router;
