const fetch = require("node-fetch"); // npm install node-fetch@2 si ce n’est pas déjà fait
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const GOOGLE_TIMEOUT_MS = Math.max(Number.parseInt(process.env.GOOGLE_DIRECTIONS_TIMEOUT_MS || "5000", 10), 1000);

async function fetchJson(url) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), GOOGLE_TIMEOUT_MS);

	try {
		const response = await fetch(url, { signal: controller.signal });
		return response;
	} finally {
		clearTimeout(timeout);
	}
}

/**
 * Récupère les itinéraires de Google Directions API
 * @param {string} depart - L'adresse ou l'arrêt de départ
 * @param {string} destination - L'adresse ou l'arrêt d'arrivée
 * @returns {Promise<Array>} - Liste d'itinéraires
 */
async function fetchItinerairesGoogle(depart, destination) {
	try {
		const params = new URLSearchParams({
			origin: depart,
			destination: destination,
			mode: "transit",
			transit_mode: "bus|subway|tram",
			key: GOOGLE_API_KEY,
			language: "fr",
			region: "BE",
			alternatives: "true",
		});

		const response = await fetchJson(`https://maps.googleapis.com/maps/api/directions/json?${params.toString()}`);

		if (!response.ok) {
			console.error("Erreur HTTP:", response.statusText);
			return [];
		}

		const data = await response.json();

		if (data.status !== "OK") {
			console.error("Erreur Directions API:", data.status);
			return [];
		}

		return data.routes;
	} catch (error) {
		console.error("Erreur API Google Directions:", error.message);
		return [];
	}
}

/**
 * Récupère une adresse lisible depuis des coordonnées (lat, lng)
 * @param {number} lat
 * @param {number} lng
 * @returns {Promise<string>} Adresse lisible
 */
async function getAdresseFromCoord(lat, lng) {
	try {
		const params = new URLSearchParams({
			latlng: `${lat},${lng}`,
			key: GOOGLE_API_KEY,
			language: "fr",
		});

		const response = await fetchJson(`https://maps.googleapis.com/maps/api/geocode/json?${params.toString()}`);
		const data = await response.json();

		const adresse = data.results?.[0]?.formatted_address;
		return adresse || `${lat}, ${lng}`;
	} catch (error) {
		console.error("Erreur reverse geocoding :", error.message);
		return `${lat}, ${lng}`;
	}
}

module.exports = { fetchItinerairesGoogle, getAdresseFromCoord };
