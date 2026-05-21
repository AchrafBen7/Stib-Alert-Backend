require("dotenv").config();

const connectDB = require("../config/db");
const redis = require("../config/redis");
const { startAssistantProactivePushLoop } = require("../services/assistantProactivePushService");

async function startWorker() {
	if (redis) {
		redis.on("connect", () => console.log("✅ Redis connecté (worker assistant)"));
		redis.on("error", (err) => console.error("❌ Redis worker :", err.message));
	} else {
		console.warn("⚠️ Redis désactivé dans le worker assistant : REDIS_URL manquant.");
	}

	const connected = await connectDB();
	if (!connected) {
		console.error("❌ Worker assistant non lancé : MongoDB indisponible.");
		process.exit(1);
	}

	const timers = [
		startAssistantProactivePushLoop(),
	].filter(Boolean);

	if (timers.length === 0) {
		console.warn("⚠️ Worker assistant démarré sans boucle active. Vérifie les variables d'environnement.");
		process.exit(0);
	}

	console.log("🤖 Worker assistant démarré.");
}

startWorker().catch((error) => {
	console.error("❌ Assistant worker fatal:", error.message);
	process.exit(1);
});
