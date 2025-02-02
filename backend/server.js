require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const connectDB = require("./config/db");
const redis = require("./config/redis"); // ✅ Import Redis

const app = express();

// Middlewares
app.use(express.json());
app.use(cors());
app.use(helmet());
app.use(morgan("dev"));

// Connexion à Redis
redis.on("connect", () => {
	console.log("✅ Redis connecté !");
});
redis.on("error", (err) => {
	console.error("❌ Erreur Redis :", err);
});

app.use("/api/signalements", require("./routes/signalementRoutes"));
app.use("/api/utilisateurs", require("./routes/utilisateurRoutes"));

// Route de test
app.get("/", (req, res) => {
	res.send("STIB Alert API fonctionne !");
});

// Démarrer le serveur après connexion à la DB
const PORT = process.env.PORT || 4000;
app.listen(PORT, async () => {
	await connectDB();
	console.log(`🚀 Serveur en cours sur http://localhost:${PORT}`);
});
