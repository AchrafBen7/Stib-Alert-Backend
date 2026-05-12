require("dotenv").config();
const connectDB = require("./config/db");
const redis = require("./config/redis");
const { initWebSocket } = require("./config/websocket");
const http = require("http");

const app = require("./app");
const server = http.createServer(app);

initWebSocket(server);

if (redis) {
	redis.on("connect", () => console.log("✅ Redis connecté !"));
	redis.on("error", (err) => console.error("❌ Erreur Redis :", err.message));
} else {
	console.warn("⚠️ Redis désactivé : REDIS_URL manquant.");
}

const { startStibOfficialSeedLoop } = require("./services/stibOfficialSeedService");
const { startCommunityJobs } = require("./services/communityJobsService");
const { startMercisLoop } = require("./services/mercisService");
const { startPreTripPushLoop } = require("./services/preTripPushService");

app.get("/privacy", (req, res) => {
	res.setHeader("Content-Type", "text/html; charset=utf-8");
	res.send(`<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Politique de confidentialité — STIB Alert</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 720px; margin: 40px auto; padding: 0 20px; color: #1a1a1a; line-height: 1.6; }
    h1 { font-size: 28px; margin-bottom: 6px; }
    h2 { font-size: 18px; margin-top: 32px; margin-bottom: 8px; }
    p, li { font-size: 15px; color: #333; }
    ul { padding-left: 20px; }
    .updated { color: #888; font-size: 13px; margin-bottom: 32px; }
    a { color: #3E7BFE; }
  </style>
</head>
<body>
  <h1>Politique de confidentialité</h1>
  <p class="updated">Dernière mise à jour : ${new Date().toLocaleDateString("fr-BE", { year: "numeric", month: "long", day: "numeric" })}</p>

  <p>STIB Alert (« l'Application ») est développée et maintenue par Achraf Benali. Cette politique explique quelles données nous collectons, pourquoi, et comment elles sont protégées.</p>

  <h2>1. Données collectées</h2>
  <ul>
    <li><strong>Données de compte</strong> : adresse e-mail, nom d'utilisateur, mot de passe haché (bcrypt).</li>
    <li><strong>Données de localisation</strong> : coordonnées GPS utilisées uniquement en temps réel pour afficher les arrêts proches et améliorer les signalements. Elles ne sont pas stockées sur nos serveurs après usage.</li>
    <li><strong>Signalements communautaires</strong> : contenu des incidents rapportés (arrêt, ligne, type de problème, description optionnelle, photo optionnelle).</li>
    <li><strong>Jeton de push</strong> : identifiant OneSignal utilisé pour envoyer des notifications. Jamais partagé à des tiers.</li>
    <li><strong>Données d'usage anonymes</strong> : écrans visités, actions effectuées — uniquement si vous activez le partage dans les paramètres de confidentialité.</li>
  </ul>

  <h2>2. Utilisation des données</h2>
  <ul>
    <li>Authentification et gestion de votre compte.</li>
    <li>Affichage des incidents en temps réel sur la carte communautaire.</li>
    <li>Envoi de notifications push liées aux perturbations sur vos lignes favorites.</li>
    <li>Génération de briefs de trajet personnalisés via l'assistant Stibi (modèle de langage externe).</li>
    <li>Amélioration du service (données d'usage anonymes, avec consentement).</li>
  </ul>

  <h2>3. Partage des données</h2>
  <p>Nous ne vendons ni ne partageons vos données personnelles à des tiers à des fins commerciales. Les données peuvent transiter via :</p>
  <ul>
    <li><strong>MongoDB Atlas</strong> (hébergement base de données, UE).</li>
    <li><strong>Redis Cloud</strong> (cache temporaire, UE).</li>
    <li><strong>OneSignal</strong> (notifications push).</li>
    <li><strong>Cloudinary</strong> (stockage photos de signalements).</li>
    <li><strong>Anthropic / OpenAI</strong> (traitement des requêtes Stibi — aucune donnée personnelle identifiable transmise).</li>
  </ul>

  <h2>4. Conservation des données</h2>
  <p>Les signalements sont automatiquement supprimés après 30 jours. Les données de compte sont conservées tant que votre compte est actif. Vous pouvez demander la suppression de votre compte depuis l'onglet Profil → Confidentialité → Supprimer votre compte.</p>

  <h2>5. Vos droits (RGPD)</h2>
  <p>Conformément au Règlement Général sur la Protection des Données (UE 2016/679), vous disposez du droit d'accès, de rectification, d'effacement et de portabilité de vos données. Pour exercer ces droits, contactez-nous à <a href="mailto:privacy@stib-alert.be">privacy@stib-alert.be</a>.</p>

  <h2>6. Sécurité</h2>
  <p>Les communications entre l'Application et le serveur sont chiffrées via HTTPS. Les mots de passe sont hachés avec bcrypt. Les tokens JWT expirent après une durée limitée.</p>

  <h2>7. Contact</h2>
  <p>Pour toute question relative à cette politique : <a href="mailto:privacy@stib-alert.be">privacy@stib-alert.be</a></p>
</body>
</html>`);
});

const PORT = process.env.PORT || 4000;

async function startServer() {
	const connected = await connectDB();
	if (!connected) {
		console.error("❌ Serveur HTTP non lancé : MongoDB indisponible.");
		process.exit(1);
	}

	startStibOfficialSeedLoop();
	startCommunityJobs();
	startMercisLoop();
	startPreTripPushLoop();

	server.listen(PORT, "0.0.0.0", () => {
		console.log(`🚀 Serveur en ligne sur le port ${PORT}`);
	});
}

startServer().catch((error) => {
	console.error("❌ Fatal server startup error:", error.message);
	process.exit(1);
});
