const express = require("express");
const { inscription, activerCompte, connexion, deconnexion, voirProfil, modifierProfil, voirVotesUtilisateur, enregistrerTokenFCM } = require("../controllers/utilisateurController");
const protect = require("../middlewares/authMiddleware");
const utilisateurController = require("../controllers/utilisateurController");
const router = express.Router();

router.post("/inscription", inscription); // ✅ Envoi du code d'activation
router.post("/activation", activerCompte); // ✅ Activation du compte avec OTP
router.post("/connexion", connexion);
router.post("/deconnexion", protect, deconnexion);
router.get("/:id", protect, voirProfil);
router.patch("/:id", protect, modifierProfil);
router.get("/:id/votes", protect, voirVotesUtilisateur);
router.patch("/:id/langue", utilisateurController.modifierLangueUtilisateur);
router.get("/previsions", utilisateurController.predireEtNotifier);
router.post("/enregistrer-token", enregistrerTokenFCM);
router.patch("/:id/favoris/:arretId", protect, utilisateurController.ajouterOuRetirerFavori);
module.exports = router;
