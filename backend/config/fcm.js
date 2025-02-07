const admin = require("firebase-admin");
const serviceAccount = require("./stib-alert-firebase-adminsdk-fbsvc-96f79df321.json");

admin.initializeApp({
	credential: admin.credential.cert(serviceAccount),
});

/**
 * ✅ Fonction pour envoyer une notification push via FCM
 * @param {string} token - Token FCM de l'utilisateur
 * @param {string} titre - Titre de la notification
 * @param {string} message - Corps de la notification
 */
exports.envoyerNotification = async (token, titre, message) => {
	try {
		const messagePayload = {
			notification: {
				title: titre,
				body: message,
			},
			token: token, // 🔹 Token FCM du device de l'utilisateur
		};

		const response = await admin.messaging().send(messagePayload);
		console.log("✅ Notification envoyée :", response);
		return response;
	} catch (error) {
		console.error("❌ Erreur lors de l'envoi de la notification :", error);
	}
};
