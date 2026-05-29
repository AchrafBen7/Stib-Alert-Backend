const mongoose = require("mongoose");

const assistantNotificationLogSchema = new mongoose.Schema(
	{
		userId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: "Utilisateur",
			required: true,
			index: true,
		},
		type: {
			type: String,
			required: true,
			index: true,
		},
		contextKey: {
			type: String,
			required: true,
			index: true,
		},
		// Clé d'incident CANONIQUE partagée entre types (perturbation officielle
		// + cluster communautaire sur la même ligne/arrêt) → dé-dup inter-types.
		incidentKey: {
			type: String,
			default: null,
			index: true,
		},
		// true = push supprimé (plafond de fréquence / mode digest), à agréger
		// dans le résumé. Résumé une fois que digestedAt est renseigné.
		deferred: {
			type: Boolean,
			default: false,
			index: true,
		},
		digestedAt: {
			type: Date,
			default: null,
		},
		priority: {
			type: String,
			default: "normal",
		},
		title: String,
		message: String,
		decision: String,
		stage: String,
		sentAt: {
			type: Date,
			default: Date.now,
		},
	},
	{
		timestamps: true,
	}
);

assistantNotificationLogSchema.index({ sentAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 14 });

module.exports = mongoose.model("AssistantNotificationLog", assistantNotificationLogSchema);
