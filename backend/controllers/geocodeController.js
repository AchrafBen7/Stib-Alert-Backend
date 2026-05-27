const { geocodeAddress } = require("../services/googleDirections");

// GET /api/geocode?q=<text>
// Forward geocoding utilisé par iOS (STIB·AI et STIB·Micro) pour résoudre
// une destination en texte libre vers (lat, lng). Biaisé Bruxelles via
// Google Geocoding API. Retourne 404 si rien trouvé pour que le client
// puisse retomber sur MKLocalSearch comme fallback.
exports.geocode = async (req, res) => {
	const q = String(req.query.q || "").trim();
	if (!q) {
		return res.status(400).json({ message: "Paramètre 'q' requis." });
	}
	if (q.length > 200) {
		return res.status(400).json({ message: "Paramètre 'q' trop long (max 200)." });
	}

	const result = await geocodeAddress(q);
	if (!result) {
		return res.status(404).json({ message: "Aucun résultat." });
	}
	return res.json(result);
};
