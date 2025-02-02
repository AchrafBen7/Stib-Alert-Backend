const express = require("express");
const { inscription, activerCompte, connexion, voirProfil, modifierProfil, voirVotesUtilisateur } = require("../controllers/utilisateurController");
const protect = require("../middlewares/authMiddleware");

const router = express.Router();

router.post("/inscription", inscription); // ✅ Envoi du code d'activation
router.post("/activation", activerCompte); // ✅ Activation du compte avec OTP
router.post("/connexion", connexion);
router.get("/:id", protect, voirProfil);
router.patch("/:id", protect, modifierProfil);
router.get("/:id/votes", protect, voirVotesUtilisateur);

module.exports = router;
