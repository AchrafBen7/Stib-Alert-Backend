const express = require("express");
const { ajouterSignalement, voirSignalements, voirSignalementsParArret, voterSignalement, voirLignesDisponibles, voirArretsParLigne, voirSignalementsParLigneEtArret } = require("../controllers/signalementController");

const router = express.Router();

// Routes existantes
router.post("/", ajouterSignalement);
router.get("/", voirSignalements);
router.get("/arret/:id", voirSignalementsParArret);
router.post("/:id/vote", voterSignalement);

// Nouvelles Routes
router.get("/lignes", voirLignesDisponibles); // Voir toutes les lignes
router.get("/ligne/:ligne", voirArretsParLigne); // Voir tous les arrêts d’une ligne
router.get("/ligne/:ligne/arret/:arretId", voirSignalementsParLigneEtArret); // Voir signalements d’un arrêt

module.exports = router;
