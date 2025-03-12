const express = require("express");
const ligneController = require("../controllers/ligneController");

const router = express.Router();

// ✅ Route pour voir toutes les lignes
router.get("/", ligneController.voirToutesLesLignes);

// ✅ Route pour voir le tracé d'une ligne
router.get("/:id/trace", ligneController.voirTraceParLigne);

// ✅ Route pour voir les perturbations d'une ligne
router.get("/:id/perturbations", ligneController.voirPerturbationsParLigne);

// ✅ Route pour voir les alternatives
router.get("/:lineid/:arretId/alternatives", ligneController.voirAlternatives);

router.get("/etat-lignes", ligneController.etatLignes);

module.exports = router;
