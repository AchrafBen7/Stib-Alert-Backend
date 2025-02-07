const { repondreQuestionChatbot } = require("../config/openai");
const Signalement = require("../models/Signalement");

exports.chatbot = async (req, res) => {
	try {
		const { question } = req.body;

		if (!question) {
			return res.status(400).json({ message: "Veuillez poser une question." });
		}

		// 🔍 Vérifier si la question concerne une ligne spécifique
		const ligneMatch = question.match(/\bligne\s*(\d+|[A-Za-z0-9]+)\b/i);
		let signalementsRecents = [];

		if (ligneMatch) {
			const ligne = ligneMatch[1];

			// 🔹 Récupérer les signalements de la ligne demandée
			signalementsRecents = await Signalement.find({ ligne }).sort({ dateSignalement: -1 }).limit(5).select("description");

			// 🔹 Formater les signalements pour le prompt
			if (signalementsRecents.length > 0) {
				var perturbations = signalementsRecents.map((s) => `- ${s.description}`).join("\n");
			} else {
				var perturbations = "Aucune perturbation récente signalée.";
			}
		} else {
			var perturbations = "Aucune information spécifique sur une ligne n'a été demandée.";
		}

		// 🧠 🔹 Création du prompt avec les données en direct
		const prompt = `
L'utilisateur pose la question : "${question}". 
Voici les signalements récents :
${perturbations}

Réponds de manière concise et utile. Si aucun signalement n'est disponible, propose une alternative raisonnable.
		`;

		// 🔹 Envoyer à OpenAI pour générer une réponse améliorée
		const reponse = await repondreQuestionChatbot(prompt);

		res.json({ question, reponse });
	} catch (error) {
		res.status(500).json({ message: error.message });
	}
};
