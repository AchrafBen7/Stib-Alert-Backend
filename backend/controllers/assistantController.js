const { buildAssistantContext, getCommandReply, getCommuteBrief, getHomeBrief, getReportHelp, getRouteBrief, sendCommuteEmail, sendCommutePush } = require("../services/assistantService");

function handleError(res, error) {
	console.error("[assistant]", error);
	res.status(error.status || 500).json({
		message: error.publicMessage || error.message || "Erreur assistant.",
	});
}

exports.voirBriefHome = async (req, res) => {
	try {
		const { lat, lng } = req.query;
		const result = await getHomeBrief({ userId: req.user?.userId || null, lat, lng });
		res.json(result);
	} catch (error) {
		handleError(res, error);
	}
};

exports.voirContext = async (req, res) => {
	try {
		const { lat, lng } = req.query;
		const result = await buildAssistantContext({ userId: req.user?.userId || null, lat, lng });
		res.json(result);
	} catch (error) {
		handleError(res, error);
	}
};

exports.voirBriefRoute = async (req, res) => {
	try {
		const { depart, destination, lignesBloquees = [] } = req.body;
		if (!depart || !destination) {
			return res.status(400).json({ message: "Les champs depart et destination sont requis." });
		}

		const result = await getRouteBrief({ userId: req.user?.userId || null, depart, destination, lignesBloquees });
		res.json(result);
	} catch (error) {
		handleError(res, error);
	}
};

exports.voirReportHelp = async (req, res) => {
	try {
		const { step, stopName, line, problemType, details, lat, lng } = req.body;
		if (!step) {
			return res.status(400).json({ message: "Le champ step est requis." });
		}

		const result = await getReportHelp({
			userId: req.user?.userId || null,
			step,
			stopName,
			line,
			problemType,
			details,
			lat,
			lng,
		});
		res.json(result);
	} catch (error) {
		handleError(res, error);
	}
};

exports.voirCommande = async (req, res) => {
	try {
		const { message, screen, lat, lng, memory = {} } = req.body;
		if (!message && !screen) {
			return res.status(400).json({ message: "Le champ message ou screen est requis." });
		}

		const result = await getCommandReply({
			userId: req.user?.userId || null,
			message,
			screen,
			lat,
			lng,
			memory,
		});
		res.json(result);
	} catch (error) {
		handleError(res, error);
	}
};

exports.voirCommuteBrief = async (req, res) => {
	try {
		const { preferredStopId, lat, lng } = req.body;
		const result = await getCommuteBrief({
			userId: req.user?.userId || null,
			preferredStopId,
			lat,
			lng,
		});
		res.json(result);
	} catch (error) {
		handleError(res, error);
	}
};

exports.envoyerCommuteEmail = async (req, res) => {
	try {
		const { preferredStopId, lat, lng } = req.body;
		const result = await sendCommuteEmail({
			userId: req.user?.userId || null,
			preferredStopId,
			lat,
			lng,
		});
		res.json(result);
	} catch (error) {
		handleError(res, error);
	}
};

exports.envoyerCommutePush = async (req, res) => {
	try {
		const { preferredStopId, lat, lng } = req.body;
		const result = await sendCommutePush({
			userId: req.user?.userId || null,
			preferredStopId,
			lat,
			lng,
		});
		res.json(result);
	} catch (error) {
		handleError(res, error);
	}
};
