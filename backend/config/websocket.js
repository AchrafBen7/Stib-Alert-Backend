const { Server } = require("socket.io");

let io;
const utilisateursAbonnes = {}; // Stocke les abonnements aux arrêts

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

		// 🔹 Gestion de la déconnexion
		socket.on("disconnect", () => {
			console.log("❌ Un utilisateur s'est déconnecté");
			// Supprime l'utilisateur de toutes les abonnements
			for (const arretId in utilisateursAbonnes) {
				utilisateursAbonnes[arretId].delete(socket.id);
				if (utilisateursAbonnes[arretId].size === 0) {
					delete utilisateursAbonnes[arretId]; // Nettoyage des abonnements vides
				}
			}
		});
	});
};

// 🔥 Émission ciblée des signalements
const emitSignalement = (signalement) => {
	if (io) {
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
