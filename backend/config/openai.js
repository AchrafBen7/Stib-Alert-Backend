const OpenAI = require("openai");
const { fetchItinerairesGoogle, getAdresseFromCoord } = require("../services/googleDirections");
const Signalement = require("../models/Signalement"); // adapte le chemin si nécessaire

const openai = new OpenAI({
	apiKey: process.env.OPENAI_API_KEY,
});

/**
 * ✅ 1. Analyse un signalement pour détecter du spam ou des propos inappropriés.
 */
exports.analyserSignalement = async (description) => {
	try {
		const prompt = `Analyse ce texte et détermine s’il contient des propos inappropriés, du spam ou une fausse alerte : "${description}". Répond uniquement par "Valide" ou "Non Valide".`;

		const response = await openai.chat.completions.create({
			model: "gpt-4o",
			messages: [{ role: "user", content: prompt }],
			max_tokens: 10,
		});

		return response.choices[0].message.content.trim() === "Valide";
	} catch (error) {
		console.error("Erreur OpenAI :", error);
		return false; // En cas d'échec, on rejette le signalement
	}
};

/**
 * ✅ 2. Génère un résumé des signalements similaires sur une période donnée.
 */
exports.genererResumeSignalements = async (signalements, ligne, arret) => {
	try {
		if (signalements.length === 0) return "Aucun signalement récent.";

		const descriptions = signalements.map((s) => s.description).join(" ");
		const prompt = `Voici une liste de problèmes signalés sur la ligne ${ligne} à l'arrêt ${arret}: ${descriptions}. Résume ces problèmes en une seule phrase claire et concise.`;

		const response = await openai.chat.completions.create({
			model: "gpt-4o",
			messages: [{ role: "user", content: prompt }],
			max_tokens: 50,
		});

		return response.choices[0].message.content.trim();
	} catch (error) {
		console.error("Erreur OpenAI :", error);
		return "Erreur lors de la génération du résumé.";
	}
};
function getDernieres24h() {
	const date = new Date();
	date.setHours(date.getHours() - 24);
	return date;
}

function getLignesDepuisItineraire(itineraire) {
	return itineraire.legs.flatMap((leg) =>
		leg.steps
			.filter((step) => step.travel_mode === "TRANSIT")
			.map((step) => step.transit_details?.line?.short_name)
			.filter(Boolean)
	);
}

function choisirPlusCourt(itineraires) {
	return itineraires.reduce((min, current) => {
		const durationMin = min.legs.reduce((sum, leg) => sum + leg.duration.value, 0);
		const durationCurrent = current.legs.reduce((sum, leg) => sum + leg.duration.value, 0);
		return durationCurrent < durationMin ? current : min;
	}, itineraires[0]);
}

async function construireMessage(itineraire) {
	const leg = itineraire.legs[0];
	const totalDuration = Math.round(leg.duration.value / 60);
	const steps = leg.steps;

	let message = `🟢 Itinéraire proposé :\n\n`;
	let currentStepIndex = 1;

	for (const step of steps) {
		if (step.travel_mode === "WALKING") {
			const walkMin = Math.round(step.duration.value / 60);
			const adresseLisible = await getAdresseFromCoord(step.end_location.lat, step.end_location.lng);
			message += `🚶 Étape ${currentStepIndex} : Marchez environ ${walkMin} min jusqu’à **${adresseLisible}**\n`;
		} else if (step.travel_mode === "TRANSIT") {
			const t = step.transit_details;
			message += `🚋 Étape ${currentStepIndex} : Prends la ligne **${t.line.short_name}** (${t.line.vehicle.type.toLowerCase()}) vers **${t.headsign}**\n`;
			message += `📍 De **${t.departure_stop.name}** à **${t.arrival_stop.name}** (${t.num_stops} arrêts, env. ${Math.round(step.duration.value / 60)} min)\n\n`;
		}
		currentStepIndex++;
	}

	message += `🕒 Temps total estimé : ${totalDuration} minutes\n\nBonne route ! 🚀`;

	return message;
}

function extraireDetailsEtapes(itineraire) {
	const steps = itineraire.legs.flatMap((leg) => leg.steps);
	const details = [];

	for (const step of steps) {
		if (step.travel_mode === "TRANSIT") {
			const ligne = step.transit_details?.line?.short_name;
			const depart = step.transit_details?.departure_stop?.name;
			const arrivee = step.transit_details?.arrival_stop?.name;
			const arrets = step.transit_details?.num_stops;

			details.push({
				ligne,
				depart,
				arrivee,
				arrets,
				type: step.transit_details?.line?.vehicle?.type || "TRANSIT",
			});
		}
	}

	return details;
}

exports.genererAlternativeItineraire = async (depart, destination, lignesBloquees = []) => {
	try {
		const itineraireData = await fetchItinerairesGoogle(depart, destination);
		const itineraireList = itineraireData || [];

		if (!itineraireList.length) {
			console.warn("⚠️ Google Directions n’a renvoyé aucun itinéraire.");
			return {
				message: "Aucun itinéraire trouvé entre ces deux points.",
				itineraire: null,
			};
		}

		const signalements = await Signalement.find({
			type: { $in: ["bloqué", "retard"] },
			date: { $gte: getDernieres24h() },
		});
		const lignesPerturbeesParArret = new Set(signalements.map((s) => `${s.ligne}-${s.arret.toUpperCase().trim()}`));
		const lignesBloqueesPropres = (lignesBloquees || []).map((l) => l.toString().trim());

		console.log("🧪 Lignes perturbées :", lignesPerturbeesParArret);

		itineraireList.forEach((itin, index) => {
			const lignes = getLignesDepuisItineraire(itin);
			console.log(`🔍 Itinéraire ${index + 1} utilise les lignes :`, lignes);
		});

		const itineraireFiltrés = itineraireList.filter((itin, i) => {
			const transitSteps = itin.legs.flatMap((leg) => leg.steps.filter((s) => s.travel_mode === "TRANSIT"));

			const rejeté = transitSteps.some((step) => {
				const ligne = step.transit_details?.line?.short_name?.trim();
				const arretDepart = step.transit_details?.departure_stop?.name?.toUpperCase().trim();
				console.log("🔎 Vérif ligne bloquée :", {
					ligne,
					lignesBloqueesPropres,
					estLigneBloquee: lignesBloqueesPropres.includes(ligne),
				});

				const ligneStep = ligne?.toString().trim();
				const estLigneBloquee = lignesBloqueesPropres.includes(ligneStep);

				const estPerturbe = lignesPerturbeesParArret.has(`${ligne}-${arretDepart}`);

				console.log(`🔍 Itinéraire ${i + 1} étape ${ligne}-${arretDepart} : ${estPerturbe || estLigneBloquee ? "🚫 Rejeté" : "✅ OK"}`);

				return estPerturbe || estLigneBloquee;
			});

			if (rejeté) console.log(`❌ Itinéraire ${i + 1} filtré à cause d'une ligne perturbée ou bloquée`);
			else console.log(`✅ Itinéraire ${i + 1} conservé`);

			return !rejeté;
		});

		const meilleur = choisirPlusCourt(itineraireFiltrés.length ? itineraireFiltrés : itineraireList);
		const message = await construireMessage(meilleur);
		const details = extraireDetailsEtapes(meilleur);

		return {
			suggestion: message,
			itineraire: meilleur,
			details: details,
		};
	} catch (err) {
		console.error("Erreur IA itinéraire:", err);
		return {
			message: "Une erreur est survenue lors de la recherche d’un itinéraire.",
			itineraire: null,
		};
	}
};

/**
 * ✅ 4. Chatbot pour répondre aux questions des utilisateurs sur les perturbations.
 */
exports.repondreQuestionChatbot = async (question) => {
	try {
		const prompt = `L'utilisateur pose la question : "${question}". Réponds en fonction des perturbations actuelles et propose des alternatives si nécessaire.`;

		const response = await openai.chat.completions.create({
			model: "gpt-4o",
			messages: [{ role: "user", content: prompt }],
			max_tokens: 100,
		});

		return {
			suggestion: response.choices[0].message.content.trim(),
			itineraire: meilleur,
		};
	} catch (error) {
		console.error("Erreur OpenAI :", error);
		return "Je ne peux pas répondre pour le moment.";
	}
};

/**
 * ✅ 5. Traduction en temps réel des signalements.
 */
exports.traduireSignalement = async (texte) => {
	try {
		const prompt = `Traduire ce texte en trois langues. Réponds strictement sous cette forme JSON : 
		{"fr": "Texte en français", "nl": "Texte en néerlandais", "en": "Texte en anglais"}. Voici le texte à traduire : "${texte}".`;

		const response = await openai.chat.completions.create({
			model: "gpt-4o",
			messages: [{ role: "user", content: prompt }],
			max_tokens: 100,
		});

		// 🔹 Tenter de parser la réponse en JSON directement
		let traduction;
		try {
			traduction = JSON.parse(response.choices[0].message.content.trim());
		} catch (error) {
			console.warn("⚠️ Format incorrect reçu d'OpenAI. Réponse brute :", response.choices[0].message.content);
			traduction = { fr: texte, nl: texte, en: texte }; // 🔹 Sécurité : Retourne le texte original en cas d'erreur
		}

		return {
			fr: traduction.fr || texte,
			nl: traduction.nl || texte,
			en: traduction.en || texte,
		};
	} catch (error) {
		console.error("Erreur OpenAI :", error);
		return { fr: texte, nl: texte, en: texte }; // 🔹 Sécurité : Évite `undefined`
	}
};

/**
 * ✅ 6. Prédiction des perturbations futures basées sur les tendances passées.
 */
exports.predireTendances = async (signalementsHistorique) => {
	try {
		if (signalementsHistorique.length === 0) return "Pas assez de données pour une prédiction.";

		const descriptions = signalementsHistorique.map((s) => s.description).join("\n");
		const prompt = `Analyse ces signalements passés et prédis les probabilités de perturbations similaires dans les prochaines heures: \n${descriptions}`;

		const response = await openai.chat.completions.create({
			model: "gpt-4o",
			messages: [{ role: "user", content: prompt }],
			max_tokens: 125,
		});

		return response.choices[0].message.content.trim();
	} catch (error) {
		console.error("Erreur OpenAI :", error);
		return "Impossible de faire une prédiction pour le moment.";
	}
};
