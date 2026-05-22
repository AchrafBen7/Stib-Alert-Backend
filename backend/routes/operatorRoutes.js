const express = require("express");
const { OPERATORS, stopsInViewport, lines, disruptions } = require("../services/operatorTransitService");

const router = express.Router();

function validOp(req, res, next) {
	if (!OPERATORS.has(req.params.op)) {
		return res.status(404).json({ message: "Opérateur inconnu." });
	}
	next();
}

// GET /api/operators/delijn/stops?minLat=&maxLat=&minLng=&maxLng=&limit=
// Stops inside the map viewport only (the app gates this to high zoom).
router.get("/:op/stops", validOp, (req, res) => {
	const num = (k) => {
		const v = parseFloat(req.query[k]);
		return Number.isFinite(v) ? v : null;
	};
	const minLat = num("minLat");
	const maxLat = num("maxLat");
	const minLng = num("minLng");
	const maxLng = num("maxLng");
	if ([minLat, maxLat, minLng, maxLng].some((v) => v === null)) {
		return res.status(400).json({ message: "bbox requis (minLat,maxLat,minLng,maxLng)." });
	}
	const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 250, 1), 500);
	res.json({
		operator: req.params.op,
		stops: stopsInViewport(req.params.op, { minLat, maxLat, minLng, maxLng }, limit),
	});
});

// GET /api/operators/delijn/lines  — full line catalog.
router.get("/:op/lines", validOp, (req, res) => {
	res.json({ operator: req.params.op, lines: lines(req.params.op) });
});

// GET /api/operators/delijn/disruptions — official perturbations.
router.get("/:op/disruptions", validOp, (req, res) => {
	res.json({ operator: req.params.op, alerts: disruptions(req.params.op) });
});

module.exports = router;
