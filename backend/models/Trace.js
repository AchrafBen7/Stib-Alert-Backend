const mongoose = require("mongoose");

const traceSchema = new mongoose.Schema({
	ligneId: { type: String, required: true }, // Utilisation de lineid de STIB, pas l’ObjectId
	geoShape: { type: Object, required: true }, // Contient les coordonnées de la ligne
});

module.exports = mongoose.model("Trace", traceSchema);
