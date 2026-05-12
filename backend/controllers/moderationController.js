const {
	listQueue,
	getQueueSummary,
	applyAction,
	flagBySignalementId,
} = require("../services/moderationService");

exports.getQueue = async (req, res) => {
	try {
		const status = req.query.status || "pending";
		const priorityTier = req.query.priority || null;
		const limit = parseInt(req.query.limit, 10) || 50;
		const skip = parseInt(req.query.skip, 10) || 0;

		const result = await listQueue({ status, priorityTier, limit, skip });
		return res.status(200).json(result);
	} catch (error) {
		console.error("[moderationController.getQueue]", error);
		return res.status(500).json({ message: "Erreur chargement queue.", error: error.message });
	}
};

exports.getSummary = async (req, res) => {
	try {
		const summary = await getQueueSummary();
		return res.status(200).json(summary);
	} catch (error) {
		console.error("[moderationController.getSummary]", error);
		return res.status(500).json({ message: "Erreur chargement résumé.", error: error.message });
	}
};

exports.actionFlag = async (req, res) => {
	try {
		const flagId = req.params.flagId;
		const { action, reason } = req.body || {};
		const adminUserId = req.user?.id || null;

		if (!["approve", "reject", "remove", "escalate"].includes(action)) {
			return res.status(400).json({ message: "Action invalide. Utilisez approve/reject/remove/escalate." });
		}

		const result = await applyAction({ flagId, action, adminUserId, reason });
		return res.status(200).json({
			flagId,
			action,
			status: result.item.status,
			clusterStatus: result.clusterStatus,
			banApplied: result.banApplied,
			message: "Action appliquée.",
		});
	} catch (error) {
		if (error.status === 404) return res.status(404).json({ message: "Flag introuvable." });
		if (error.status === 409) return res.status(409).json({ message: "Flag déjà traité." });
		console.error("[moderationController.actionFlag]", error);
		return res.status(500).json({ message: "Action impossible.", error: error.message });
	}
};

exports.userReport = async (req, res) => {
	try {
		const signalementId = req.params.id;
		const { reason = "spam", note = null } = req.body || {};

		if (!["spam", "offensive", "duplicate", "misinformation"].includes(reason)) {
			return res.status(400).json({ message: "Motif invalide." });
		}

		const userId = req.user?.id || null;
		const flag = await flagBySignalementId(signalementId, {
			reason,
			flaggedBy: userId || "user",
			note,
		});

		return res.status(202).json({
			flagId: flag._id,
			queued: true,
			message: "Signalement enregistré pour modération.",
		});
	} catch (error) {
		if (error.status === 404) return res.status(404).json({ message: "Signalement introuvable." });
		console.error("[moderationController.userReport]", error);
		return res.status(500).json({ message: "Impossible d'enregistrer.", error: error.message });
	}
};
