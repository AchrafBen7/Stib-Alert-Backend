const OpenAI = require("openai");

const openai = new OpenAI({
	apiKey: process.env.OPENAI_API_KEY,
});

exports.analyserSignalement = async (description) => {
	try {
		const prompt = `Analyse ce texte et détermine s’il contient des propos inappropriés, du spam ou une fausse alerte : "${description}". Répond uniquement par "Valide" ou "Non Valide".`;

		const response = await openai.chat.completions.create({
			model: "gpt-4o", // Utilisation du modèle GPT-4o
			messages: [{ role: "user", content: prompt }],
			max_tokens: 10,
		});

		return response.choices[0].message.content.trim() === "Valide";
	} catch (error) {
		console.error("Erreur OpenAI :", error);
		return false; // En cas d'échec, on rejette le signalement
	}
};
