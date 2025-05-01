require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const connectDB = require("./config/db");
const redis = require("./config/redis"); // ✅ Import Redis
const { initWebSocket } = require("./config/websocket");
const http = require("http");
const cookieParser = require("cookie-parser"); // ✅ Import de cookie-parser
const path = require("path");
const app = express();
const server = http.createServer(app);

// Initialiser WebSockets
initWebSocket(server);

// Middlewares
app.use(express.json());
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(cookieParser());
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
app.use("/api/lignes", require("./routes/ligneRoutes"));
app.use("/api/chatbot", require("./routes/chatbotRoutes"));
app.use("/api/arrets", require("./routes/arretRoute"));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// Route de test
app.get("/", (req, res) => {
	res.send("STIB Alert API fonctionne !");
});

// Démarrer le serveur après connexion à la DB
const PORT = process.env.PORT || 4000;
app.listen(PORT, "0.0.0.0", async () => {
	await connectDB();
	console.log(`🚀 Serveur en ligne sur le port ${PORT}`);
});
