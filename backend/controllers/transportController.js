const {
	getTransportLine,
	getTransportOverview,
	getTransportStop,
	recommendRoute,
} = require("../services/transportService");
const { listEventImpacts } = require("../services/eventCrowdingService");
const Arret = require("../models/Arret");

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

exports.listerEvenements = async (req, res) => {
	try {
		const { line, q, activeOnly, limit } = req.query;
		const result = listEventImpacts({
			line: line || null,
			query: q || null,
			activeOnly: String(activeOnly || "").toLowerCase() === "true",
			limit: limit ? Number.parseInt(limit, 10) : undefined,
		});
		const stopNames = [...new Set(result.flatMap((event) => event.impactedStops || []).filter(Boolean))];
		const matchedStops = stopNames.length
			? await Arret.find({ nom: { $in: stopNames } }).select("_id stop_id nom").lean()
			: [];
		const stopLookup = matchedStops.reduce((accumulator, stop) => {
			accumulator[String(stop.nom || "").toLowerCase()] = {
				id: String(stop._id),
				stopId: stop.stop_id || null,
				name: stop.nom,
			};
			return accumulator;
		}, {});
		const enriched = result.map((event) => ({
			...event,
			impactedStopDetails: (event.impactedStops || []).map((name) => {
				const match = stopLookup[String(name || "").toLowerCase()];
				return match || { id: null, stopId: null, name };
			}),
		}));
		res.json({
			events: enriched,
			meta: {
				line: line || null,
				query: q || null,
				activeOnly: String(activeOnly || "").toLowerCase() === "true",
				total: enriched.length,
			},
		});
	} catch (error) {
		handleError(res, error);
	}
};
