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

async function fetchDirections({
	depart,
	destination,
	mode = "transit",
	transitModes = ["bus", "subway", "tram"],
	alternatives = true,
}) {
	try {
		const params = new URLSearchParams({
			origin: depart,
			destination: destination,
			mode,
			key: GOOGLE_API_KEY,
			language: "fr",
			region: "BE",
			alternatives: alternatives ? "true" : "false",
		});

		if (mode === "transit" && transitModes.length) {
			params.set("transit_mode", transitModes.join("|"));
		}

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

		return data.routes || [];
	} catch (error) {
		console.error("Erreur API Google Directions:", error.message);
		return [];
	}
}

/**
 * Récupère les itinéraires STIB / transit.
 * @param {string} depart
 * @param {string} destination
 * @returns {Promise<Array>}
 */
async function fetchItinerairesGoogle(depart, destination) {
	return fetchDirections({
		depart,
		destination,
		mode: "transit",
		transitModes: ["bus", "subway", "tram"],
		alternatives: true,
	});
}

async function fetchItinerairesGoogleWalk(depart, destination) {
	return fetchDirections({
		depart,
		destination,
		mode: "walking",
		alternatives: false,
	});
}

async function fetchItinerairesGoogleBike(depart, destination) {
	return fetchDirections({
		depart,
		destination,
		mode: "bicycling",
		alternatives: false,
	});
}

/**
 * Forward geocoding : transforme une chaîne libre (adresse, monument,
 * "Avenue des Désirs, Schaerbeek"…) en coordonnées Bruxelles, en biaisant
 * le résultat sur la Belgique. Utilisé par STIB·AI et STIB·Micro quand le
 * catalogue STIB local n'a pas trouvé d'arrêt qui matche — Google a une
 * couverture d'adresses bien supérieure à MKLocalSearch d'Apple en BE.
 *
 * @param {string} query — texte libre (1-200 chars)
 * @returns {Promise<{lat: number, lng: number, name: string, formattedAddress: string, types: string[]} | null>}
 */
async function geocodeAddress(query) {
	const trimmed = String(query || "").trim().slice(0, 200);
	if (!trimmed) return null;
	if (!GOOGLE_API_KEY) {
		console.warn("[geocode] GOOGLE_API_KEY manquante");
		return null;
	}

	try {
		const params = new URLSearchParams({
			address: trimmed,
			key: GOOGLE_API_KEY,
			language: "fr",
			region: "be",
			// Brussels-area bounding box pour prioriser les résultats locaux
			// sans EXCLURE (un user peut taper "Charleroi" et on veut quand
			// même un résultat).
			bounds: "50.760,4.230|50.940,4.490",
		});

		const response = await fetchJson(`https://maps.googleapis.com/maps/api/geocode/json?${params.toString()}`);
		if (!response.ok) {
			console.error("[geocode] HTTP", response.status, response.statusText);
			return null;
		}
		const data = await response.json();
		if (data.status !== "OK" || !Array.isArray(data.results) || data.results.length === 0) {
			if (data.status !== "ZERO_RESULTS") {
				console.warn("[geocode] status:", data.status, "for query:", trimmed);
			}
			return null;
		}

		const top = data.results[0];
		const loc = top.geometry && top.geometry.location;
		if (!loc) return null;

		return {
			lat: loc.lat,
			lng: loc.lng,
			name: top.address_components?.[0]?.long_name || trimmed,
			formattedAddress: top.formatted_address || trimmed,
			types: top.types || [],
		};
	} catch (error) {
		console.error("[geocode] erreur:", error.message);
		return null;
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

module.exports = {
	fetchItinerairesGoogle,
	fetchItinerairesGoogleWalk,
	fetchItinerairesGoogleBike,
	getAdresseFromCoord,
	geocodeAddress,
};
