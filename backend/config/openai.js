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
	if (!process.env.OPENAI_API_KEY) {
		return true;
	}

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
		return true; // En cas d'échec, on n'empêche pas un signalement réel
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

function normaliserLigne(line) {
	return line?.toString().trim().toUpperCase() || null;
}

function getLignesDepuisItineraire(itineraire) {
	return itineraire.legs.flatMap((leg) =>
		leg.steps
			.filter((step) => step.travel_mode === "TRANSIT")
			.map((step) => normaliserLigne(step.transit_details?.line?.short_name))
			.filter(Boolean)
	);
}

function getDurationValue(itineraire) {
	return itineraire.legs.reduce((sum, leg) => sum + leg.duration.value, 0);
}

function calculerPoidsSignalement(signalement) {
	const poidsConfiance = {
		haute: 3,
		moyenne: 2,
		basse: 1,
	};
	const poidsProbleme = {
		Panne: 4,
		Accident: 4,
		Agression: 4,
		Incivilité: 2,
		Retard: 2,
		Propreté: 1,
		Autre: 1,
	};

	return (poidsProbleme[signalement.typeProbleme] || 1) * (poidsConfiance[signalement.confiance] || 1);
}

function construireIndicePerturbations(signalements) {
	const lignes = new Map();

	for (const signalement of signalements) {
		const ligne = normaliserLigne(signalement.ligne);
		if (!ligne) continue;

		if (!lignes.has(ligne)) {
			lignes.set(ligne, {
				count: 0,
				score: 0,
				types: new Set(),
			});
		}

		const ligneData = lignes.get(ligne);
		ligneData.count += 1;
		ligneData.score += calculerPoidsSignalement(signalement);
		ligneData.types.add(signalement.typeProbleme);
	}

	return lignes;
}

function evaluerItineraire(itineraire, lignesBloqueesSet, perturbationsParLigne) {
	const lignes = getLignesDepuisItineraire(itineraire);
	const lignesUniques = [...new Set(lignes)];
	const lignesBloqueesDansItineraire = lignesUniques.filter((ligne) => lignesBloqueesSet.has(ligne));
	const scorePerturbation = lignesUniques.reduce((sum, ligne) => sum + (perturbationsParLigne.get(ligne)?.score || 0), 0);
	const nombreIncidents = lignesUniques.reduce((sum, ligne) => sum + (perturbationsParLigne.get(ligne)?.count || 0), 0);
	const duration = getDurationValue(itineraire);

	return {
		itineraire,
		lignes: lignesUniques,
		lignesBloqueesDansItineraire,
		scorePerturbation,
		nombreIncidents,
		duration,
	};
}

function choisirMeilleurItineraire(evaluations) {
	return evaluations.reduce((best, current) => {
		if (!best) return current;
		if (current.lignesBloqueesDansItineraire.length !== best.lignesBloqueesDansItineraire.length) {
			return current.lignesBloqueesDansItineraire.length < best.lignesBloqueesDansItineraire.length ? current : best;
		}
		if (current.scorePerturbation !== best.scorePerturbation) {
			return current.scorePerturbation < best.scorePerturbation ? current : best;
		}
		if (current.nombreIncidents !== best.nombreIncidents) {
			return current.nombreIncidents < best.nombreIncidents ? current : best;
		}
		return current.duration < best.duration ? current : best;
	}, null);
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

		const lignesBloqueesSet = new Set((lignesBloquees || []).map(normaliserLigne).filter(Boolean));
		const lignesUtilisees = [...new Set(itineraireList.flatMap(getLignesDepuisItineraire))];
		const signalements = await Signalement.find({
			ligne: { $in: lignesUtilisees },
			typeProbleme: { $in: ["Retard", "Panne"] },
			dateSignalement: { $gte: getDernieres24h() },
		}).lean();
		const perturbationsParLigne = construireIndicePerturbations(signalements);

		const evaluations = itineraireList.map((itineraire) => evaluerItineraire(itineraire, lignesBloqueesSet, perturbationsParLigne));
		const itinerairesSansLigneBloquee = evaluations.filter((evaluation) => evaluation.lignesBloqueesDansItineraire.length === 0);
		const meilleur = choisirMeilleurItineraire(itinerairesSansLigneBloquee.length ? itinerairesSansLigneBloquee : evaluations);

		if (!meilleur?.itineraire) {
			return {
				message: "Aucun itinéraire exploitable n’a pu être calculé.",
				itineraire: null,
				details: [],
			};
		}

		const message = await construireMessage(meilleur.itineraire);
		const details = extraireDetailsEtapes(meilleur.itineraire);

		return {
			suggestion: message,
			itineraire: meilleur.itineraire,
			details,
			meta: {
				lignesAnalysees: meilleur.lignes,
				lignesBloqueesEcartees: meilleur.lignesBloqueesDansItineraire,
				scorePerturbation: meilleur.scorePerturbation,
				nombreIncidents: meilleur.nombreIncidents,
				dureeSecondes: meilleur.duration,
			},
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
			itineraire: null,
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
