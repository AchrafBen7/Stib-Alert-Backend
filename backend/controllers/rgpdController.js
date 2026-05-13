const Utilisateur = require("../models/Utilisateur");
const Signalement = require("../models/Signalement");
const Cluster = require("../models/Cluster");
const ModerationQueueItem = require("../models/ModerationQueueItem");
const DeviceLimit = require("../models/DeviceLimit");
const Arret = require("../models/Arret");
const redis = require("../config/redis");

const PRIVACY_EMAIL = process.env.PRIVACY_CONTACT_EMAIL || "privacy@stib-alert.be";

exports.exportMyData = async (req, res) => {
	try {
		const userId = req.user?.userId;
		if (!userId) {
			return res.status(401).json({ message: "Authentification requise." });
		}

		const utilisateur = await Utilisateur.findById(userId).lean();
		if (!utilisateur) {
			return res.status(404).json({ message: "Utilisateur introuvable." });
		}

		delete utilisateur.motDePasse;
		delete utilisateur.password;
		delete utilisateur.refreshTokenHash;
		delete utilisateur.activationCode;

		const signalements = await Signalement.find({ utilisateurId: userId })
			.select("-reporterIpHash -reporterDeviceHash")
			.populate("arretId", "nom stop_id")
			.lean();

		const favorisDetails = utilisateur.favoris && utilisateur.favoris.length > 0
			? await Arret.find({ _id: { $in: utilisateur.favoris } })
				.select("stop_id nom latitude longitude lignesDesservies")
				.lean()
			: [];

		const moderationFlags = await ModerationQueueItem.find({
			"signalementSnapshot.authorType": { $in: ["authenticated"] },
			signalementId: { $in: signalements.map((s) => s._id) },
		})
			.select("flagReason flaggedAt status priority")
			.lean();

		const exportPayload = {
			generatedAt: new Date().toISOString(),
			rgpdNotice: "Vos données personnelles telles que stockées chez StibAlert (RGPD art. 15 - droit d'accès).",
			privacyContact: PRIVACY_EMAIL,
			account: {
				_id: utilisateur._id,
				email: utilisateur.email,
				nom: utilisateur.nom,
				role: utilisateur.role,
				preferredLanguage: utilisateur.preferredLanguage,
				createdAt: utilisateur.createdAt,
				updatedAt: utilisateur.updatedAt,
				notificationsEnabled: utilisateur.notificationsEnabled,
			},
			favoris: favorisDetails,
			signalements: signalements.map((s) => ({
				_id: s._id,
				ligne: s.ligne,
				typeProbleme: s.typeProbleme,
				description: s.description,
				dateSignalement: s.dateSignalement,
				latitude: s.latitude,
				longitude: s.longitude,
				confiance: s.confiance,
				trust: s.trust,
				status: s.status,
				moderationStatus: s.moderationStatus,
				votesPositifs: s.votesPositifs,
				votesNegatifs: s.votesNegatifs,
				arret: s.arretId,
				clusterIndex: s.clusterIndex,
			})),
			signalementsCount: signalements.length,
			moderationFlagsAgainstYou: moderationFlags,
			retentionPolicy: {
				signalements: `${process.env.SIGNALEMENT_TTL_DAYS || 30} jours après création`,
				accountData: "tant que le compte est actif (suppression sur demande)",
				ipAndDevice: "Jamais stockés en clair, uniquement sous forme de hash SHA256",
			},
		};

		res.setHeader("Content-Disposition", `attachment; filename="stibalert-data-${userId}.json"`);
		res.setHeader("Content-Type", "application/json");
		return res.status(200).json(exportPayload);
	} catch (error) {
		console.error("[rgpd.exportMyData]", error);
		return res.status(500).json({ message: "Impossible de générer l'export.", error: error.message });
	}
};

exports.deleteMyAccount = async (req, res) => {
	try {
		const userId = req.user?.userId;
		if (!userId) {
			return res.status(401).json({ message: "Authentification requise." });
		}

		const utilisateur = await Utilisateur.findById(userId);
		if (!utilisateur) {
			return res.status(404).json({ message: "Utilisateur introuvable." });
		}

		const { confirmation } = req.body || {};
		if (confirmation !== "SUPPRIMER MON COMPTE") {
			return res.status(400).json({
				message: "Confirmation requise. Envoyez 'confirmation': 'SUPPRIMER MON COMPTE' dans le corps.",
				required: "SUPPRIMER MON COMPTE",
			});
		}

		const signalementsResult = await Signalement.updateMany(
			{ utilisateurId: userId },
			{
				$set: {
					utilisateurId: null,
					authorType: "anonymous",
					description: "[Compte supprimé]",
					moderationStatus: "rejected",
					status: "archived",
					reporterIpHash: null,
					reporterDeviceHash: null,
					photo: null,
				},
			}
		);

		await ModerationQueueItem.updateMany(
			{ "signalementSnapshot.utilisateurId": userId },
			{ $set: { "signalementSnapshot.description": "[Compte supprimé]" } }
		);

		const authToken = req.headers.authorization?.replace(/^Bearer\s+/i, "");
		if (redis && authToken) {
			try {
				await redis.del(`auth:${authToken}`);
				await redis.del(`refresh:${userId}`);
			} catch (e) {
				console.warn("[rgpd] redis cache cleanup failed:", e.message);
			}
		}

		await Utilisateur.deleteOne({ _id: userId });

		return res.status(200).json({
			message: "Votre compte et vos données personnelles ont été supprimés.",
			signalementsAnonymized: signalementsResult.modifiedCount || 0,
			retentionNote: "Les signalements anonymisés restent visibles 30 jours pour la fiabilité historique, sans aucun lien avec votre identité.",
			contact: PRIVACY_EMAIL,
		});
	} catch (error) {
		console.error("[rgpd.deleteMyAccount]", error);
		return res.status(500).json({ message: "Impossible de supprimer le compte.", error: error.message });
	}
};

exports.myInsights = async (req, res) => {
	try {
		const userId = req.user?.userId;
		if (!userId) {
			return res.status(401).json({ message: "Authentification requise." });
		}
		const { computeInsights } = require("../services/insightsService");
		const daysBack = Number(req.query.daysBack) || 30;
		const insights = await computeInsights({ userId, daysBack });
		if (!insights) {
			return res.status(404).json({ message: "Utilisateur introuvable." });
		}
		res.setHeader("Cache-Control", "private, max-age=600");
		return res.status(200).json(insights);
	} catch (error) {
		console.error("[rgpd.myInsights]", error);
		return res.status(500).json({ message: "Erreur insights.", error: error.message });
	}
};

exports.myContributions = async (req, res) => {
	try {
		const userId = req.user?.userId;
		if (!userId) {
			return res.status(401).json({ message: "Authentification requise." });
		}
		const { getUserContributionsSummary } = require("../services/mercisService");
		const summary = await getUserContributionsSummary(userId);

		const Contribution = require("../models/Contribution");
		const recent = await Contribution.find({ utilisateurId: userId })
			.sort({ createdAt: -1 })
			.limit(20)
			.select("ligne typeProbleme role helpedPublishCluster peopleHelped createdAt clusterIndex")
			.lean();

		return res.status(200).json({
			summary,
			recent,
		});
	} catch (error) {
		console.error("[rgpd.myContributions]", error);
		return res.status(500).json({ message: "Erreur stats contributions.", error: error.message });
	}
};

exports.privacyPolicy = (req, res) => {
	res.status(200).json({
		dataController: "StibAlert (Achraf Benali)",
		dpoContact: PRIVACY_EMAIL,
		collected: [
			"Email + nom (compte)",
			"Coordonnées GPS au moment du signalement (jamais stockées en continu)",
			"Description et photo de signalements",
			"Hash SHA256 de l'IP et device-id (anti-spam, jamais raw)",
			"Token push OneSignal (notifications)",
		],
		purposes: [
			"Authentification et gestion du compte",
			"Affichage des incidents en temps réel",
			"Notifications de perturbations sur vos lignes favorites",
			"Anti-spam (rate limiting + détection abus)",
		],
		sharedWith: [
			{ provider: "MongoDB Atlas", purpose: "Hébergement DB", region: "EU" },
			{ provider: "Redis Cloud", purpose: "Cache + sessions", region: "EU" },
			{ provider: "OneSignal", purpose: "Push notifications", region: "EU/US" },
			{ provider: "Cloudinary", purpose: "Stockage photos", region: "EU" },
			{ provider: "OpenAI", purpose: "Modération IA (aucune donnée personnelle)", region: "US" },
		],
		retention: {
			signalements: `${process.env.SIGNALEMENT_TTL_DAYS || 30} jours`,
			account: "Tant que le compte est actif, supprimable sur demande",
			deviceLimits: "90 jours après dernière activité",
		},
		userRights: [
			"Accès à vos données: GET /api/utilisateurs/me/export",
			"Suppression: DELETE /api/utilisateurs/me + corps { confirmation: 'SUPPRIMER MON COMPTE' }",
			"Rectification: PATCH /api/utilisateurs/:id",
			"Opposition: désactiver les notifications dans le profil",
		],
		legalBasis: "Consentement (RGPD art. 6.1.a) + intérêt légitime (anti-spam, RGPD art. 6.1.f)",
		generatedAt: new Date().toISOString(),
	});
};
