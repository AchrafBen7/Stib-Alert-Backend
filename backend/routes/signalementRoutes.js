const express = require("express");
const { voirSignalements, voterSignalement, voirLignesDisponibles, voirArretsParLigne, voirSignalementsParLigneEtArret, supprimerSignalement, signalerFauxSignalement } = require("../controllers/signalementController");
const protect = require("../middlewares/authMiddleware");
const router = express.Router();
const signalementController = require("../controllers/signalementController");
const isAdmin = require("../middlewares/adminMiddleware");

// Routes existantes
router.post("/", signalementController.ajouterSignalement);
router.get("/", voirSignalements);
router.get("/arret/:id", signalementController.voirSignalementsParArret);
router.post("/:id/vote", protect, voterSignalement);
router.post("/:id/signalement-faux", protect, signalerFauxSignalement);

// Nouvelles Routes
router.get("/lignes", voirLignesDisponibles); // Voir toutes les lignes
router.get("/ligne/:ligne", voirArretsParLigne); // Voir tous les arrêts d’une ligne
router.get("/ligne/:ligne/arret/:arretId", voirSignalementsParLigneEtArret); // Voir signalements d’un arrêt
router.get("/:id/traduire", signalementController.traduireSignalement);

// 📌 Suppression (ADMIN uniquement)
router.delete("/:id", protect, isAdmin, supprimerSignalement); //
module.exports = router;

router.get("/arret/:arretId/signalement/:signalementId", signalementController.voirUnSignalementParArret);
