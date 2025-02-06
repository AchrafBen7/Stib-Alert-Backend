const express = require("express");
const { voirToutesLesLignes, voirTraceParLigne } = require("../controllers/ligneController");
const ligneController = require("../controllers/ligneController");
const router = express.Router();

// ✅ Nouvelle route pour voir toutes les lignes
router.get("/", voirToutesLesLignes);

// ✅ Route pour voir le tracé d'une ligne
router.get("/:id/trace", voirTraceParLigne);

router.get("/:id/perturbations", ligneController.voirPerturbationsParLigne);
router.get("/api/lignes/:lineid/:arretId/alternatives", ligneController.voirAlternatives);

module.exports = router;
