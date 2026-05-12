const crypto = require("crypto");
const {
	getActiveClusters,
	getClusterDetail,
	confirmStillBlocked,
	confirmResolved,
} = require("../services/clusterService");

function clientDeviceHash(req) {
	const id = String(req.headers["x-stib-device-id"] || req.headers["x-device-id"] || "").trim();
	if (!id) return null;
	const salt = process.env.SIGNALEMENT_PRIVACY_SALT || process.env.JWT_SECRET || "stib-alert";
	return crypto.createHmac("sha256", salt).update(id).digest("hex");
}

function parseBbox(query) {
	if (!query.bbox) return null;
	const parts = String(query.bbox).split(",").map(parseFloat);
	if (parts.length !== 4 || parts.some(Number.isNaN)) return null;
	const [minLat, minLng, maxLat, maxLng] = parts;
	if (minLat > maxLat || minLng > maxLng) return null;
	return { minLat, minLng, maxLat, maxLng };
}

function serializeCluster(cluster) {
	return {
		clusterIndex: cluster.clusterIndex,
		ligne: cluster.ligne,
		arretId: cluster.arretId,
		typeProbleme: cluster.typeProbleme,
		reportCount: cluster.reportCount,
		aggregateTrust: cluster.aggregateTrust,
		confidence: cluster.confidence,
		stillBlockedConfirmationCount: cluster.stillBlockedConfirmationCount || 0,
		resolveConfirmationCount: cluster.resolveConfirmationCount || 0,
		resolved: cluster.resolved || false,
		status: cluster.status,
		firstReportedAt: cluster.firstReportedAt,
		lastReportedAt: cluster.lastReportedAt,
		expiresAt: cluster.expiresAt,
		isOfficial: cluster.isOfficial || false,
		position: cluster.latitude != null && cluster.longitude != null
			? { lat: cluster.latitude, lng: cluster.longitude }
			: null,
	};
}

exports.listActive = async (req, res) => {
	try {
		const bbox = parseBbox(req.query);
		const lineId = req.query.ligne || req.query.lineId || null;
		const limit = parseInt(req.query.limit, 10) || 100;

		const clusters = await getActiveClusters({ bbox, lineId, limit });

		res.setHeader("Cache-Control", "public, max-age=30");
		return res.status(200).json({
			clusters: clusters.map(serializeCluster),
			count: clusters.length,
			fetchedAt: new Date().toISOString(),
		});
	} catch (error) {
		console.error("[clusterController.listActive]", error);
		return res.status(500).json({
			message: "Impossible de charger les alertes communautaires.",
			error: error.message,
		});
	}
};

exports.getDetail = async (req, res) => {
	try {
		const clusterIndex = parseInt(req.params.clusterIndex, 10);
		if (!Number.isFinite(clusterIndex)) {
			return res.status(400).json({ message: "Identifiant cluster invalide." });
		}

		const detail = await getClusterDetail(clusterIndex);
		if (!detail) {
			return res.status(404).json({ message: "Alerte introuvable." });
		}

		return res.status(200).json({
			...serializeCluster(detail),
			signalements: detail.signalements || [],
		});
	} catch (error) {
		console.error("[clusterController.getDetail]", error);
		return res.status(500).json({
			message: "Impossible de charger les détails.",
			error: error.message,
		});
	}
};

exports.confirmStillBlocked = async (req, res) => {
	try {
		const clusterIndex = parseInt(req.params.clusterIndex, 10);
		if (!Number.isFinite(clusterIndex)) {
			return res.status(400).json({ message: "Identifiant cluster invalide." });
		}

		const userId = req.user?.id || null;
		const actorHash = clientDeviceHash(req);

		if (!userId && !actorHash) {
			return res.status(400).json({ message: "Identifiant requis (utilisateur ou appareil)." });
		}

		const result = await confirmStillBlocked({ clusterIndex, userId, actorHash });

		return res.status(200).json({
			clusterIndex,
			confirmationCount: result.confirmationCount || result.cluster?.stillBlockedConfirmationCount || 0,
			expiresAt: result.cluster?.expiresAt,
			message: result.message,
		});
	} catch (error) {
		if (error.status === 404) {
			return res.status(404).json({ message: "Alerte introuvable." });
		}
		console.error("[clusterController.confirmStillBlocked]", error);
		return res.status(500).json({
			message: "Confirmation impossible.",
			error: error.message,
		});
	}
};

exports.confirmResolved = async (req, res) => {
	try {
		const clusterIndex = parseInt(req.params.clusterIndex, 10);
		if (!Number.isFinite(clusterIndex)) {
			return res.status(400).json({ message: "Identifiant cluster invalide." });
		}

		const userId = req.user?.id || null;
		const actorHash = clientDeviceHash(req);

		if (!userId && !actorHash) {
			return res.status(400).json({ message: "Identifiant requis (utilisateur ou appareil)." });
		}

		const result = await confirmResolved({ clusterIndex, userId, actorHash });

		return res.status(200).json({
			clusterIndex,
			confirmationCount: result.confirmationCount,
			resolved: result.resolved,
			message: result.message,
		});
	} catch (error) {
		if (error.status === 404) {
			return res.status(404).json({ message: "Alerte introuvable." });
		}
		console.error("[clusterController.confirmResolved]", error);
		return res.status(500).json({
			message: "Confirmation impossible.",
			error: error.message,
		});
	}
};
