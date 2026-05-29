const mongoose = require("mongoose");

const utilisateurSchema = new mongoose.Schema(
	{
		nom: { type: String, required: true },
		// lowercase + trim so an email can never be stored in two casings and
		// silently spawn duplicate accounts (e.g. Apple Sign-In returning a
		// differently-cased address than the email/password signup).
		email: { type: String, required: true, unique: true, lowercase: true, trim: true },
		// Optional because Sign in with Apple users never set one — the field
		// still holds a bcrypt hash for email/password users.
		motDePasse: { type: String, default: null },
		photoProfil: { type: String },
		tokenPush: { type: String },
		oneSignalPlayerId: { type: String },
		favoris: [{ type: mongoose.Schema.Types.ObjectId, ref: "Arret" }],
		// #3 — Favoris multi-opérateurs (SNCB / De Lijn / TEC) synchronisés
		// serveur, comme les favoris STIB. Avant : stockés UNIQUEMENT en local
		// (UserDefaults) → perdus à la réinstallation, jamais cross-device.
		operatorFavorites: [{
			op: { type: String, trim: true, lowercase: true },     // "sncb" | "delijn" | "tec"
			stopId: { type: String, trim: true },
			name: { type: String, trim: true, maxlength: 160 },
			lat: { type: Number, default: null },
			lng: { type: Number, default: null },
			createdAt: { type: Date, default: Date.now },
		}],
		favoriteLines: [{ type: String, trim: true, uppercase: true }],
		routine: {
			enabled: { type: Boolean, default: false },
			homeLabel: { type: String, trim: true, maxlength: 80 },
			workLabel: { type: String, trim: true, maxlength: 80 },
			departureTime: { type: String, trim: true, maxlength: 5 },
			homeStopId: { type: mongoose.Schema.Types.ObjectId, ref: "Arret", default: null },
			workStopId: { type: mongoose.Schema.Types.ObjectId, ref: "Arret", default: null },
		},
		langue: { type: String, enum: ["FR", "NL", "EN"], default: "FR" },
		notifications: { type: Boolean, default: true },
		weeklyDigestEnabled: { type: Boolean, default: true },
		preTripPushEnabled: { type: Boolean, default: true },
		communityClusterPushEnabled: { type: Boolean, default: true },
		mercisPushEnabled: { type: Boolean, default: true },
		quietHoursEnabled: { type: Boolean, default: true },
		quietHoursStartHour: { type: Number, default: 22, min: 0, max: 23 },
		quietHoursEndHour: { type: Number, default: 7, min: 0, max: 23 },
		// Débit global des alertes : "tout" (relâche les plafonds), "essentiel"
		// (défaut), "critique" (seul Accident/Agression/Interruption passe),
		// "digest" (rien en direct sauf critique, tout va au résumé).
		notificationFrequency: {
			type: String,
			enum: ["tout", "essentiel", "critique", "digest"],
			default: "essentiel",
		},
		// Affinage par ligne/arrêt/zone : niveau de notif par cible suivie.
		// level : "tout" | "essentiel" | "critique" | "off".
		notificationRules: [{
			scope: { type: String, enum: ["line", "stop", "zone"], required: true },
			key: { type: String, required: true },   // ex. "92", un stopId, ou "home"
			level: { type: String, enum: ["tout", "essentiel", "critique", "off"], default: "essentiel" },
		}],
		lastPreTripPushAt: { type: Date, default: null },
		role: { type: String, enum: ["Utilisateur", "Admin"], default: "Utilisateur" },
		votes: [{ type: mongoose.Schema.Types.ObjectId, ref: "Signalement" }],
		refreshToken: { type: String, default: null },
		refreshTokenExpiry: { type: Date, default: null },
		appleUserId: { type: String, default: null, index: true, sparse: true },
	},
	{ timestamps: true }
);

module.exports = mongoose.model("Utilisateur", utilisateurSchema);
