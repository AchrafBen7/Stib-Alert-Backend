const mongoose = require("mongoose");
const Ligne = require("../models/Ligne");
require("dotenv").config();
const fs = require("fs");

// Connexion à MongoDB
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true, // ⚠️ Supprimer car non nécessaire dans Mongoose v6+
  useUnifiedTopology: true // ⚠️ Supprimer car non nécessaire dans Mongoose v6+
});

const importData = async () => {
  try {
    // Charger le fichier JSON
    const rawData = fs.readFileSync("./stops-by-line-production.json", "utf-8");
    const data = JSON.parse(rawData);

    // Nettoyage et transformation des données
    const lignes = data.map((ligne) => ({
      lineid: ligne.lineid,
      destination: JSON.parse(ligne.destination), // ✅ Corrige le problème de `destination`
      direction: ligne.direction,
      points: JSON.parse(ligne.points) // ✅ Convertir `points` en tableau d'objets
    }));

    // Nettoyage de la base
    await Ligne.deleteMany(); // ❌ Supprime les anciennes données
    await Ligne.insertMany(lignes); // ✅ Insère les nouvelles données

    console.log("✅ Données STIB importées avec succès !");
    process.exit();
  } catch (error) {
    console.error("❌ Erreur lors de l'importation :", error);
    process.exit(1);
  }
};

// Exécuter l'importation
importData();
