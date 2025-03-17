const express = require("express");
const { ajouterArret, ajouterLigne, synchroniserArretAvecLigne, ajouterLigneAArrêt } = require("../controllers/arretController");
const router = express.Router();

router.post("/ajouter-arret", ajouterArret); // ✅ Créer un arrêt
router.post("/ajouter-ligne", ajouterLigne); // ✅ Créer une ligne
router.put("/synchroniser-arret-ligne/:arretId/:ligneId", synchroniserArretAvecLigne); // ✅ Associer un arrêt à une ligne
router.put("/ajouter-ligne-a-arret/:arretId/:ligneId", ajouterLigneAArrêt);

module.exports = router;
