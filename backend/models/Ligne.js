const mongoose = require("mongoose");

const ligneSchema = new mongoose.Schema({
  lineid: { type: String, required: true, unique: true }, // Ex: "1", "2", "7"
  destination: {
    fr: { type: String, required: true },
    nl: { type: String, required: true },
  },
  direction: { type: String, enum: ["City", "Suburb"], required: true },
  points: [
    {
      id: { type: String, required: true }, // ID de l'arrêt
      order: { type: Number, required: true }, // Ordre d'arrêt
    }
  ]
});

module.exports = mongoose.model("Ligne", ligneSchema);
