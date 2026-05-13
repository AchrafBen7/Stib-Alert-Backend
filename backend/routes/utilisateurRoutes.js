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
const {
	signupLimiter,
	activationLimiter,
	loginLimiter,
	refreshLimiter,
} = require("../middlewares/rateLimiters");
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

const rgpdController = require("../controllers/rgpdController");
router.get("/me/export", protect, rgpdController.exportMyData);
router.get("/me/contributions", protect, rgpdController.myContributions);
router.get("/me/insights", protect, rgpdController.myInsights);
router.delete("/me", protect, rgpdController.deleteMyAccount);
router.get("/privacy/policy", rgpdController.privacyPolicy);

router.post("/inscription", signupLimiter, validateSignup, handleValidation, inscription);
router.post("/activation", activationLimiter, validateActivation, handleValidation, activerCompte);
router.post("/renvoyer-code", activationLimiter, utilisateurController.renvoyerCode);
router.post("/connexion", loginLimiter, validateLogin, handleValidation, connexion);
router.post("/deconnexion", protect, deconnexion);
router.post("/refresh", refreshLimiter, utilisateurController.refresh);

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

router.delete("/:id", protect, validateMongoId, handleValidation, requireSelf(), utilisateurController.supprimerCompte);

router.post("/enregistrer-token", protect, validatePushToken, handleValidation, enregistrerTokenFCM);

module.exports = router;
