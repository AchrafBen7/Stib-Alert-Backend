const express = require("express");
const { ajouterArret, ajouterLigne, synchroniserArretAvecLigne } = require("../controllers/arretController");
const router = express.Router();

router.post("/ajouter-arret", ajouterArret); // ✅ Créer un arrêt
router.post("/ajouter-ligne", ajouterLigne); // ✅ Créer une ligne
router.put("/synchroniser-arret-ligne/:arretId/:ligneId", synchroniserArretAvecLigne); // ✅ Associer un arrêt à une ligne

module.exports = router;
