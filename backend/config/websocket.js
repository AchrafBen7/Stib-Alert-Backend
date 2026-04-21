const { Server } = require("socket.io");
const { getVehiclePositions } = require("../services/belgianMobility");

let io;
const utilisateursAbonnes = {}; // Stocke les abonnements aux arrêts
let vehiclePollingInterval = null;
let vehicleTrackingClients = new Set(); // Clients abonnés au tracking véhicules

const VEHICLE_POLL_INTERVAL_MS = 30000; // Poll toutes les 30 secondes (quota API limité)

const initWebSocket = (server) => {
	io = new Server(server, {
		cors: { origin: "*" },
	});

	io.on("connection", (socket) => {
		console.log("🔌 Un utilisateur est connecté à WebSockets");

		// 🔹 Gestion des abonnements aux arrêts
		socket.on("souscrireArret", (arretId) => {
			if (!utilisateursAbonnes[arretId]) {
				utilisateursAbonnes[arretId] = new Set();
			}
			utilisateursAbonnes[arretId].add(socket.id);
			console.log(`📍 Utilisateur ${socket.id} abonné à l'arrêt ${arretId}`);
		});

		// 🔹 Abonnement au tracking véhicules en temps réel
		socket.on("subscribeVehicleTracking", (options) => {
			vehicleTrackingClients.add(socket.id);
			socket.join("vehicleTracking");
			console.log(`🚍 Utilisateur ${socket.id} abonné au tracking véhicules`);
			startVehiclePolling();
		});

		socket.on("unsubscribeVehicleTracking", () => {
			vehicleTrackingClients.delete(socket.id);
			socket.leave("vehicleTracking");
			console.log(`🚍 Utilisateur ${socket.id} désabonné du tracking véhicules`);
			if (vehicleTrackingClients.size === 0) {
				stopVehiclePolling();
			}
		});

		// 🔹 Gestion de la déconnexion
		socket.on("disconnect", () => {
			console.log("❌ Un utilisateur s'est déconnecté");
			vehicleTrackingClients.delete(socket.id);
			if (vehicleTrackingClients.size === 0) {
				stopVehiclePolling();
			}
			for (const arretId in utilisateursAbonnes) {
				utilisateursAbonnes[arretId].delete(socket.id);
				if (utilisateursAbonnes[arretId].size === 0) {
					delete utilisateursAbonnes[arretId];
				}
			}
		});
	});
};

// 🚍 Polling des positions véhicules depuis Belgian Mobility API
async function fetchAndBroadcastVehiclePositions() {
	try {
		const result = await getVehiclePositions({});
		const positions = result.items.map((item) => ({
			vehicleId: item.vehicleId,
			line: item.line,
			direction: item.direction,
			latitude: item.latitude,
			longitude: item.longitude,
			updatedAt: item.updatedAt,
		}));

		if (io && positions.length > 0) {
			io.to("vehicleTracking").emit("vehiclePositions", {
				timestamp: new Date().toISOString(),
				count: positions.length,
				vehicles: positions,
			});
		}
	} catch (error) {
		console.error("❌ Erreur polling positions véhicules:", error.message);
	}
}

function startVehiclePolling() {
	if (vehiclePollingInterval) return; // Déjà actif
	console.log("🚍 Démarrage du polling des positions véhicules");
	fetchAndBroadcastVehiclePositions(); // Premier appel immédiat
	vehiclePollingInterval = setInterval(fetchAndBroadcastVehiclePositions, VEHICLE_POLL_INTERVAL_MS);
}

function stopVehiclePolling() {
	if (vehiclePollingInterval) {
		clearInterval(vehiclePollingInterval);
		vehiclePollingInterval = null;
		console.log("🚍 Arrêt du polling des positions véhicules (plus de clients)");
	}
}

// 🔥 Émission ciblée des signalements
const emitSignalement = (signalement) => {
	if (io) {
		io.emit("nouveauSignalementGlobal", signalement);
		const { arretId } = signalement;
		if (utilisateursAbonnes[arretId]) {
			utilisateursAbonnes[arretId].forEach((socketId) => {
				io.to(socketId).emit("nouveauSignalement", signalement);
			});
			console.log(`🚀 Signalement envoyé aux abonnés de l'arrêt ${arretId}`);
		}
	}
};

module.exports = { initWebSocket, emitSignalement };
