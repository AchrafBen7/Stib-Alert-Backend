require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const mongoSanitize = require("express-mongo-sanitize");
const connectDB = require("./config/db");
const redis = require("./config/redis");
const { initWebSocket } = require("./config/websocket");
const { globalLimiter } = require("./middlewares/rateLimiters");
const http = require("http");
const cookieParser = require("cookie-parser");

const app = express();
const server = http.createServer(app);

initWebSocket(server);

const allowedOrigins = (process.env.CORS_ORIGINS || "")
	.split(",")
	.map((o) => o.trim())
	.filter(Boolean);

app.use(helmet());
app.use(
	cors({
		origin: allowedOrigins.length ? allowedOrigins : true,
		credentials: true,
	})
);
app.use(express.json({ limit: "10mb" }));
app.use(cookieParser());
app.use(mongoSanitize());
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));
app.use(globalLimiter);

if (redis) {
	redis.on("connect", () => console.log("✅ Redis connecté !"));
	redis.on("error", (err) => console.error("❌ Erreur Redis :", err.message));
} else {
	console.warn("⚠️ Redis désactivé : REDIS_URL manquant.");
}

app.use("/api/signalements", require("./routes/signalementRoutes"));
app.use("/api/utilisateurs", require("./routes/utilisateurRoutes"));
app.use("/api/lignes", require("./routes/ligneRoutes"));
app.use("/api/chatbot", require("./routes/chatbotRoutes"));
app.use("/api/arrets", require("./routes/arretRoute"));
app.use("/api/stib", require("./routes/stibRealtimeRoutes"));
app.use("/api/transport", require("./routes/transportRoutes"));
app.use("/api/assistant", require("./routes/assistantRoutes"));

app.get("/", (req, res) => res.send("STIB Alert API fonctionne !"));

app.use((err, req, res, _next) => {
	console.error("❌", err.message);
	if (err.type === "entity.too.large") {
		return res.status(413).json({ message: "Payload trop volumineux." });
	}
	res.status(err.status || 500).json({
		message: err.publicMessage || "Erreur serveur.",
	});
});

const PORT = process.env.PORT || 4000;

async function startServer() {
	const connected = await connectDB();
	if (!connected) {
		console.error("❌ Serveur HTTP non lancé : MongoDB indisponible.");
		process.exit(1);
	}

	server.listen(PORT, "0.0.0.0", () => {
		console.log(`🚀 Serveur en ligne sur le port ${PORT}`);
	});
}

startServer().catch((error) => {
	console.error("❌ Fatal server startup error:", error.message);
	process.exit(1);
});
