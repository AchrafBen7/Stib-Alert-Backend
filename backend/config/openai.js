const OpenAI = require("openai");

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

/**
 * ✅ 3. Génère des itinéraires alternatifs en cas de perturbation.
 */
exports.genererSuggestionAlternative = async (ligne, arret, alternatives) => {
	try {
		if (alternatives.length === 0) return "Aucune alternative disponible.";

		const prompt = `Le ${ligne} est bloqué à ${arret}. Quelles sont les meilleures alternatives en utilisant ces lignes : ${alternatives.join(", ")} ?`;

		const response = await openai.chat.completions.create({
			model: "gpt-4o",
			messages: [{ role: "user", content: prompt }],
			max_tokens: 50,
		});

		return response.choices[0].message.content.trim();
	} catch (error) {
		console.error("Erreur OpenAI :", error);
		return "Erreur lors de la génération de la suggestion.";
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

		return response.choices[0].message.content.trim();
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
			max_tokens: 100,
		});

		return response.choices[0].message.content.trim();
	} catch (error) {
		console.error("Erreur OpenAI :", error);
		return "Impossible de faire une prédiction pour le moment.";
	}
};
