const mongoose = require("mongoose");

const utilisateurSchema = new mongoose.Schema(
	{
		nom: { type: String, required: true },
		email: { type: String, required: true, unique: true },
		motDePasse: { type: String, required: true },
		photoProfil: { type: String },
		tokenPush: { type: String },
		oneSignalPlayerId: { type: String },
		favoris: [{ type: mongoose.Schema.Types.ObjectId, ref: "Arret" }],
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
		lastPreTripPushAt: { type: Date, default: null },
		role: { type: String, enum: ["Utilisateur", "Admin"], default: "Utilisateur" },
		votes: [{ type: mongoose.Schema.Types.ObjectId, ref: "Signalement" }],
		refreshToken: { type: String, default: null },
		refreshTokenExpiry: { type: Date, default: null },
	},
	{ timestamps: true }
);

module.exports = mongoose.model("Utilisateur", utilisateurSchema);
