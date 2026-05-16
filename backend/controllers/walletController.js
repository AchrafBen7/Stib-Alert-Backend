const Utilisateur = require("../models/Utilisateur");
const { generateMobibPass, isConfigured, missingPieces } = require("../services/walletPassService");
const logger = require("../services/logger");

/**
 * Generates an Apple Wallet .pkpass for the authenticated user from the
 * MoBIB data the iOS client persists locally (sent in the request body so
 * we don't need a server-side copy of the card).
 *
 * POST /api/wallet/mobib-pass
 * Body: { holderName, cardNumber, subscriptionLabel, expiryDate }
 * Returns: application/vnd.apple.pkpass binary
 */
exports.generateMobibPass = async (req, res) => {
	try {
		if (!isConfigured()) {
			const details = missingPieces();
			logger.warn("[wallet] generation refused, service not configured", details);
			return res.status(503).json({
				message: "Apple Wallet n'est pas encore activé sur ce serveur.",
				details,
			});
		}

		const userId = req.user?.userId;
		if (!userId) {
			return res.status(401).json({ message: "Authentification requise." });
		}

		const user = await Utilisateur.findById(userId).select("nom email").lean();
		if (!user) {
			return res.status(404).json({ message: "Utilisateur introuvable." });
		}

		const pass = {
			holderName: typeof req.body?.holderName === "string" ? req.body.holderName.trim() : "",
			cardNumber: typeof req.body?.cardNumber === "string" ? req.body.cardNumber.trim() : "",
			subscriptionLabel: typeof req.body?.subscriptionLabel === "string" ? req.body.subscriptionLabel.trim() : "",
			expiryDate: req.body?.expiryDate ? new Date(req.body.expiryDate) : null,
		};

		const buffer = await generateMobibPass({ user, pass });

		res.setHeader("Content-Type", "application/vnd.apple.pkpass");
		res.setHeader("Content-Disposition", "attachment; filename=\"mobib.pkpass\"");
		res.setHeader("Cache-Control", "no-store");
		return res.status(200).send(buffer);
	} catch (error) {
		if (error.code === "WALLET_NOT_INSTALLED") {
			return res.status(503).json({
				message: "Composant Apple Wallet absent sur ce serveur.",
			});
		}
		logger.error("[wallet] generation failed", { error: error.message });
		return res.status(500).json({
			message: "Génération du pass Apple Wallet impossible.",
			error: error.message,
		});
	}
};
