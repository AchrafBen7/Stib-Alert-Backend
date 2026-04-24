const {
	getTransportLine,
	getTransportOverview,
	getTransportStop,
	recommendRoute,
} = require("../services/transportService");

function handleError(res, error) {
	console.error("[transport]", error);
	res.status(error.status || 500).json({
		message: error.publicMessage || error.message || "Erreur transport.",
	});
}

exports.voirOverview = async (req, res) => {
	try {
		const { lat, lng } = req.query;
		const result = await getTransportOverview({ lat, lng });
		res.json(result);
	} catch (error) {
		handleError(res, error);
	}
};

exports.voirArret = async (req, res) => {
	try {
		const result = await getTransportStop(req.params.id);
		res.json(result);
	} catch (error) {
		handleError(res, error);
	}
};

exports.voirLigne = async (req, res) => {
	try {
		const result = await getTransportLine(req.params.id);
		res.json(result);
	} catch (error) {
		handleError(res, error);
	}
};

exports.recommanderItineraire = async (req, res) => {
	try {
		const { depart, destination, lignesBloquees = [] } = req.body;
		if (!depart || !destination) {
			return res.status(400).json({ message: "Les champs depart et destination sont requis." });
		}

		const result = await recommendRoute({ depart, destination, lignesBloquees });
		res.json(result);
	} catch (error) {
		handleError(res, error);
	}
};
