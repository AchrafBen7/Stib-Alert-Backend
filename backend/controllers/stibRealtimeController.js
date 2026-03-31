const {
	getShapeFiles,
	getStopDetails,
	getTravellersInformation,
	getWaitingTimes,
	getVehiclePositions,
} = require("../services/belgianMobility");

function includeRaw(req) {
	return String(req.query.includeRaw || "false").toLowerCase() === "true";
}

function formatResponse(req, endpoint, result) {
	return {
		source: "belgian-mobility",
		endpoint,
		count: result.items.length,
		items: result.items.map((item) => (includeRaw(req) ? item : { ...item, raw: undefined })),
		raw: includeRaw(req) ? result.payload : undefined,
	};
}

function handleError(res, error) {
	const status = error.status || 500;
	return res.status(status).json({
		message: "Impossible de récupérer les données STIB temps réel.",
		error: error.message,
		details: error.details || null,
	});
}

exports.voirTravellersInformation = async (req, res) => {
	try {
		const result = await getTravellersInformation(req.query);
		res.json(formatResponse(req, "TravellersInformation", result));
	} catch (error) {
		handleError(res, error);
	}
};

exports.voirWaitingTimes = async (req, res) => {
	try {
		const result = await getWaitingTimes(req.query);
		res.json(formatResponse(req, "WaitingTimes", result));
	} catch (error) {
		handleError(res, error);
	}
};

exports.voirVehiclePositions = async (req, res) => {
	try {
		const result = await getVehiclePositions(req.query);
		res.json(formatResponse(req, "VehiclePositions", result));
	} catch (error) {
		handleError(res, error);
	}
};

exports.voirShapeFiles = async (req, res) => {
	try {
		const result = await getShapeFiles(req.query);
		res.json(formatResponse(req, "ShapeFiles", result));
	} catch (error) {
		handleError(res, error);
	}
};

exports.voirStopDetails = async (req, res) => {
	try {
		const result = await getStopDetails(req.query);
		res.json(formatResponse(req, "StopDetails", result));
	} catch (error) {
		handleError(res, error);
	}
};
