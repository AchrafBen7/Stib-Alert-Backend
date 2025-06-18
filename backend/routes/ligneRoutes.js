const express = require("express");
const ligneController = require("../controllers/ligneController");

const router = express.Router();

// ✅ Route pour voir toutes les lignes
router.get("/", ligneController.voirToutesLesLignes);
router.get("/etat-lignes", ligneController.etatLignes);
router.get("/:lineid/arrets", ligneController.voirArretsParLigne);
// ✅ Route pour voir une ligne spécifique par son ID STIB (lineid)
router.get("/:lineid", ligneController.voirLigneParLineID);

// Route pour voir toutes les lignes disponibles
router.get("/toutes", ligneController.voirToutesLesLignesDisponibles);

// ✅ Route pour voir le tracé d'une ligne
router.get("/:id/trace", ligneController.voirTraceParLigne);

// ✅ Route pour voir les perturbations d'une ligne
router.get("/:id/perturbations", ligneController.voirPerturbationsParLigne);

// ✅ Route pour voir les alternatives
router.post("/alternatives", ligneController.voirAlternativeItineraire);

router.patch("/:id/ajouter-retour", ligneController.ajouterNomCompletRetour);
router.post("/:lineid/arrets", ligneController.ajouterArretALigne);
router.get("/maj-order", ligneController.majOrderPourLigne);
module.exports = router;
