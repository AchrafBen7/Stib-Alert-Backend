const express = require("express");
const { OPERATORS, stopsInViewport, lines } = require("../services/operatorTransitService");
const delijnLive = require("../services/delijnLiveService");
const tecLive = require("../services/tecLiveService");

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
// Pour De Lijn, version LIVE depuis l'API officielle (cache 3 min).
// Si la clé est absente ou l'API down → fallback snapshot statique.
// Pour TEC, reste le snapshot statique (pas d'API live branchée pour l'instant).
router.get("/:op/disruptions", validOp, async (req, res) => {
	if (req.params.op === "delijn" && delijnLive.isConfigured()) {
		const live = await delijnLive.getNetworkDisruptions();
		if (live) {
			// IMPORTANT : le catalogue iOS (delijn-lines.json) stocke des
			// GTFS route_id type "gr:delijn:18010" alors que l'API De Lijn
			// renvoie un lijnnummer ("128"). Reconstruction d'un "gr:delijn:X"
			// est impossible sans table de correspondance. On émet donc le
			// short_name BRUT comme routeId — l'iOS matche désormais
			// sur OperatorLine.shortName (commit miroir côté Swift).
			const alerts = live.disruptions.map((d) => ({
				id: d.id,
				header: d.title,
				description: d.description,
				url: "",
				routeIds: d.affectedLines.map((l) => String(l.line)),
				startDate: d.startDate,
				endDate: d.endDate,
			}));
			return res.json({
				operator: "delijn",
				live: true,
				fetchedAt: live.fetchedAt,
				count: alerts.length,
				alerts,
			});
		}
	}
	// TEC : GTFS-RT JSON via Belgian Mobility Company (même clé que STIB).
	// 1 appel toutes les 3 min seulement → quota mutualisé négligeable.
	if (req.params.op === "tec" && tecLive.isConfigured()) {
		const live = await tecLive.getNetworkDisruptions();
		if (live) {
			const alerts = live.disruptions.map((d) => ({
				id: d.id,
				header: d.title,
				description: d.description,
				url: d.url || "",
				routeIds: d.affectedLines.map((l) => l.line),
				startDate: d.startDate,
				endDate: d.endDate,
			}));
			return res.json({
				operator: "tec",
				live: true,
				fetchedAt: live.fetchedAt,
				count: alerts.length,
				alerts,
			});
		}
	}
	// Aucune source live disponible (clé manquante OU API down). On renvoie
	// une liste vide avec live:false plutôt que les anciens snapshots
	// statiques (qui dataient de mai 2025, ~80% des alertes étaient
	// périmées). L'iOS gère "0 alertes + live:false" comme un état dégradé
	// neutre — préférable à de la désinformation.
	res.json({
		operator: req.params.op,
		live: false,
		alerts: [],
	});
});

// GET /api/operators/delijn/stops/:stopId/realtime
// Prochains passages en temps réel (next ~30 min, avec délai en minutes).
// Cache 60s par arrêt côté backend → 240 req/min Kernel API de De Lijn
// supporte ~100 utilisateurs simultanés sans saturer.
router.get("/:op/stops/:stopId/realtime", validOp, async (req, res) => {
	if (req.params.op !== "delijn") {
		return res.status(404).json({ message: "Endpoint disponible uniquement pour De Lijn." });
	}
	if (!delijnLive.isConfigured()) {
		return res.status(503).json({
			message: "Service temps réel De Lijn non configuré (DELIJN_API_KEY manquante).",
			live: false,
			passages: [],
		});
	}
	const data = await delijnLive.getStopRealtime(req.params.stopId);
	res.json(data);
});

// GET /api/operators/delijn/stops/:stopId/disruptions
// Déviations (omleidingen) + pannes (storingen) qui touchent cet arrêt précis.
router.get("/:op/stops/:stopId/disruptions", validOp, async (req, res) => {
	if (req.params.op !== "delijn") {
		return res.status(404).json({ message: "Endpoint disponible uniquement pour De Lijn." });
	}
	if (!delijnLive.isConfigured()) {
		return res.status(503).json({
			message: "Service De Lijn non configuré.",
			live: false,
			omleidingen: [],
			storingen: [],
		});
	}
	const data = await delijnLive.getStopDisruptions(req.params.stopId);
	if (!data) return res.status(502).json({ message: "Service De Lijn indisponible." });
	res.json(data);
});

module.exports = router;
