const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const mongoSanitize = require("express-mongo-sanitize");
const cookieParser = require("cookie-parser");
const { globalLimiter } = require("./middlewares/rateLimiters");
const logger = require("./services/logger");

const app = express();

// Render is behind a reverse proxy; use forwarded client IPs for rate limiting.
app.set("trust proxy", 1);

app.use(helmet());
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "10mb" }));
app.use(cookieParser());
app.use(mongoSanitize());
if (process.env.NODE_ENV !== "test") {
    const morgan = require("morgan");
    app.use(morgan("dev"));
}
app.use(globalLimiter);
if (process.env.NODE_ENV !== "test") {
    app.use(logger.requestMiddleware());
}

const appleTeamId = process.env.APPLE_TEAM_ID || "SLUL8PUP37";
const appleBundleId = process.env.APPLE_BUNDLE_ID || "com.ehb.StibAlert";
const appleAppSiteAssociation = {
	applinks: {
		apps: [],
		details: [{
			appIDs: [`${appleTeamId}.${appleBundleId}`],
			components: [
				{ "/": "/signalement/*" },
				{ "/": "/signalements" },
				{ "/": "/reports" },
				{ "/": "/privacy" },
			],
		}],
	},
};

function sendAppleAppSiteAssociation(_req, res) {
	res
		.type("application/json")
		.set("Cache-Control", "public, max-age=3600")
		.status(200)
		.send(JSON.stringify(appleAppSiteAssociation));
}

app.get("/apple-app-site-association", sendAppleAppSiteAssociation);
app.get("/.well-known/apple-app-site-association", sendAppleAppSiteAssociation);

app.use("/api/signalements", require("./routes/signalementRoutes"));
app.use("/api/clusters", require("./routes/clusterRoutes"));
app.use("/api/decision", require("./routes/decisionRoutes"));
app.use("/api/lines", require("./routes/lineRealtimeRoutes"));
app.use("/admin/moderation", require("./routes/moderationRoutes"));
app.use("/api/utilisateurs", require("./routes/utilisateurRoutes"));
app.use("/api/lignes", require("./routes/ligneRoutes"));
app.use("/api/chatbot", require("./routes/chatbotRoutes"));
app.use("/api/arrets", require("./routes/arretRoute"));
app.use("/api/stib", require("./routes/stibRealtimeRoutes"));
app.use("/api/transport", require("./routes/transportRoutes"));
app.use("/api/assistant", require("./routes/assistantRoutes"));
app.use("/api/wallet", require("./routes/walletRoutes"));

app.get("/", (req, res) => res.send("STIB Alert API fonctionne !"));

// /health is intentionally DB-free so external keep-warm pings can wake the
// Render free-tier container without waiting on Mongo. Cron-job.org / GitHub
// Actions hit this every ~14min to keep the dyno hot.
app.get("/health", (req, res) => {
	res.status(200).json({ ok: true, uptime: process.uptime() });
});

app.use((err, req, res, _next) => {
    if (err.type === "entity.too.large") {
        return res.status(413).json({ message: "Payload trop volumineux." });
    }
    const reqLogger = req.logger || logger;
    reqLogger.error("unhandled_error", {
        message: err.message,
        code: err.code,
        status: err.status,
        stack: process.env.NODE_ENV === "production" ? undefined : err.stack,
    });
    res.status(err.status || 500).json({
        message: err.publicMessage || "Erreur serveur.",
    });
});

module.exports = app;
