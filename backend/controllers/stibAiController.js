const fetch = require("node-fetch");
const { STIB_AI_SYSTEM_PROMPT } = require("../services/stibAiSystemPrompt");
const { buildContextMessage } = require("../services/stibAiContextBuilder");
const logger = require("../services/logger");

const DEFAULT_GATEWAY_URL = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_MODEL = "gemini-2.5-flash";

function sanitizeMessages(messages) {
	if (!Array.isArray(messages)) return [];
	return messages
		.slice(-12)
		.map((message) => ({
			role: message?.role === "assistant" ? "assistant" : "user",
			content: String(message?.content || "").slice(0, 4000),
		}))
		.filter((message) => message.content.trim().length > 0);
}

function writeSseDelta(res, text) {
	res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
}

function writeSseDone(res) {
	res.write("data: [DONE]\n\n");
}

function endSse(res) {
	if (res.writableEnded) return;
	writeSseDone(res);
	res.end();
}

function startSse(res) {
	res.status(200);
	res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
	res.setHeader("Cache-Control", "no-cache, no-transform");
	res.setHeader("Connection", "keep-alive");
	res.setHeader("X-Accel-Buffering", "no");
	if (typeof res.flushHeaders === "function") res.flushHeaders();
	res.write(": connected\n\n");
}

function apiKey() {
	return process.env.GEMINI_API_KEY
		|| process.env.OPENAI_API_KEY
		|| process.env.LOVABLE_API_KEY
		|| process.env.ANTHROPIC_API_KEY;
}

function modelForGateway(model, gatewayUrl) {
	if (gatewayUrl.includes("generativelanguage.googleapis.com") && model.startsWith("google/")) {
		return model.replace(/^google\//, "");
	}
	return model;
}

function shouldUseGeminiNative(gatewayUrl) {
	return gatewayUrl.includes("generativelanguage.googleapis.com") && !gatewayUrl.includes("/openai/");
}

function geminiNativeUrl(gatewayUrl, model) {
	const baseUrl = gatewayUrl.replace(/\/$/, "");
	if (baseUrl.includes(":streamGenerateContent")) return `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}alt=sse`;
	return `${baseUrl}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
}

// Override appliqué au chat textuel — équivalent du voiceInstruction pour
// le mode voix. L'app fait l'extraction + le géocodage + le planning AVANT
// d'appeler Gemini, donc si TRAJET CALCULÉ apparaît dans le contexte, le
// modèle DOIT le décrire au lieu de renvoyer l'utilisateur au planner.
// Sans cet override, Gemini retombait régulièrement sur "veuillez utiliser
// le planificateur" même quand proposedRoutes était bien populé.
const TEXT_CHAT_INSTRUCTION = [
	"============================================",
	"MODE CHAT TEXTE — RAPPELS QUI ÉCRASENT LE PROMPT SYSTÈME",
	"============================================",
	"",
	"L'app iOS a déjà résolu la destination + calculé l'itinéraire AVANT cet appel. Si une section TRAJET CALCULÉ est présente dans le contexte, c'est ta source de vérité absolue — tu DOIS la décrire en détail (format ## Meilleure option, badges [[L:NUM]], arrêts en **MAJUSCULES**), tu n'as PAS à la valider, ni demander confirmation.",
	"Si l'option proposée est uniquement à pied, ne l'appelle pas alternative transport. Dis 'À pied uniquement' et compare brièvement avec les autres options calculées si elles existent.",
	"Si plusieurs options existent, indique pourquoi tu recommandes l'une d'elles: plus rapide, moins risquée, moins de marche ou moins de correspondances. Ne choisis jamais une option qui ne correspond pas aux étapes calculées.",
	"",
	"⛔️ PHRASES STRICTEMENT INTERDITES (jamais) :",
	"  - 'Je ne trouve pas de trajet' / 'Je n'ai pas de trajet calculé' QUAND un TRAJET CALCULÉ est présent (c'est factuellement faux)",
	"  - 'utilisez le planificateur' / 'le planner d'itinéraire de l'app' (l'app L'A déjà fait pour toi avant d'appeler ce prompt)",
	"  - 'cette destination n'est pas reconnue' (le géocodage Google + catalogue STIB a déjà tranché)",
	"  - 'Voulez-vous aller à X ? Sinon, utilisez le planificateur' (formule de refus interdite)",
	"",
	"✅ Si TRAJET CALCULÉ est ABSENT ET l'utilisateur demande un trajet :",
	"  - Demande UNE précision courte et actionnable (ex: 'Quelle station précisément ?', 'Près de quel monument ?', 'C'est l'arrêt de tram ou la rue ?')",
	"  - Maximum 1 question, courte. Pas de paragraphe.",
].join("\n");

function geminiContents(messages, contextMessage) {
	const systemContext = [STIB_AI_SYSTEM_PROMPT, contextMessage, TEXT_CHAT_INSTRUCTION].filter(Boolean).join("\n\n");
	const contents = [];
	if (systemContext) {
		contents.push({ role: "user", parts: [{ text: systemContext }] });
	}
	for (const message of messages) {
		contents.push({
			role: message.role === "assistant" ? "model" : "user",
			parts: [{ text: message.content }],
		});
	}
	return contents;
}

function geminiChunkText(payload) {
	return payload?.candidates
		?.flatMap((candidate) => candidate?.content?.parts || [])
		?.map((part) => part?.text || "")
		?.join("") || "";
}

async function streamGeminiNative({ gatewayUrl, model, key, messages, contextMessage, controller, res }) {
	const body = JSON.stringify({
		contents: geminiContents(messages, contextMessage),
		generationConfig: {
			temperature: 0.35,
			topP: 0.9,
		},
	});

	async function callModel(modelName) {
		return fetch(geminiNativeUrl(gatewayUrl, modelName), {
			method: "POST",
			headers: {
				"x-goog-api-key": key,
				"Content-Type": "application/json",
				Accept: "text/event-stream",
			},
			body,
			signal: controller.signal,
		});
	}

	// Même résilience que voiceAsk : Gemini 2.5-flash sort régulièrement
	// du 503 "high demand" sur les pics de trafic. On retry 1× après 700 ms
	// sur le même modèle, puis on bascule sur 1.5-flash (moins chargé)
	// AVANT de jeter l'éponge. Sans ça, le user voyait juste
	// "L'assistant IA est temporairement indisponible" → expérience cassée
	// alors qu'un simple retry passait.
	const fallbackModel = "gemini-1.5-flash";
	let upstream = await callModel(model);

	if (upstream.status === 503) {
		logger.warn("stib_ai_503_retry", { model });
		await new Promise((r) => setTimeout(r, 700));
		upstream = await callModel(model);
	}
	if (upstream.status === 503 && model !== fallbackModel) {
		logger.warn("stib_ai_503_fallback", { from: model, to: fallbackModel });
		upstream = await callModel(fallbackModel);
	}

	if (!upstream.ok) {
		const errBody = await upstream.text().catch(() => "");
		logger.warn("stib_ai_gemini_error", {
			status: upstream.status,
			body: errBody.slice(0, 500),
		});
		// Message aligné avec voiceAsk pour cohérence STIB·AI texte vs voix.
		const message = upstream.status === 429
			? "L'assistant reçoit trop de demandes pour le moment. Réessaie dans quelques secondes."
			: upstream.status === 503
				? "L'assistant est saturé pour quelques secondes, réessaie tout de suite."
				: "L'assistant IA est temporairement indisponible. Réessaie dans un instant.";
		writeSseDelta(res, message);
		return endSse(res);
	}

	if (!upstream.body) {
		return endSse(res);
	}

	let buffer = "";
	upstream.body.on("data", (chunk) => {
		buffer += chunk.toString("utf8");
		const lines = buffer.split(/\r?\n/);
		buffer = lines.pop() || "";

		for (const line of lines) {
			if (!line.startsWith("data:")) continue;
			const data = line.replace(/^data:\s*/, "").trim();
			if (!data || data === "[DONE]") continue;
			try {
				const text = geminiChunkText(JSON.parse(data));
				if (text) writeSseDelta(res, text);
			} catch (error) {
				logger.warn("stib_ai_gemini_parse_error", { message: error.message });
			}
		}
	});
	upstream.body.on("end", () => {
		endSse(res);
	});
	upstream.body.on("error", (error) => {
		logger.warn("stib_ai_gemini_stream_error", { message: error.message });
		if (!res.writableEnded) {
			writeSseDelta(res, "\n\nLe flux Gemini a été interrompu. Réessaie dans quelques secondes.");
			endSse(res);
		}
	});
	return undefined;
}

exports.streamChat = async (req, res) => {
	const messages = sanitizeMessages(req.body?.messages);
	if (!messages.length) {
		return res.status(400).json({ message: "messages array required." });
	}

	const key = apiKey();
	const contextMessage = req.body?.context ? buildContextMessage(req.body.context) : "";

	startSse(res);

	if (!key) {
		writeSseDelta(res, "L'assistant IA n'est pas encore configuré côté serveur. Ajoute `LOVABLE_API_KEY` ou `OPENAI_API_KEY` sur le backend, puis réessaie.");
		writeSseDone(res);
		return res.end();
	}

	const gatewayUrl = process.env.AI_GATEWAY_URL || DEFAULT_GATEWAY_URL;
	const model = modelForGateway(process.env.AI_MODEL || DEFAULT_MODEL, gatewayUrl);
	const controller = new AbortController();

	res.on("close", () => {
		if (!res.writableEnded) controller.abort();
	});

	try {
		if (shouldUseGeminiNative(gatewayUrl)) {
			return await streamGeminiNative({
				gatewayUrl,
				model,
				key,
				messages,
				contextMessage,
				controller,
				res,
			});
		}

		const upstream = await fetch(gatewayUrl, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${key}`,
				"Content-Type": "application/json",
				Accept: "text/event-stream",
			},
			body: JSON.stringify({
				model,
				stream: true,
				messages: [
					{ role: "system", content: STIB_AI_SYSTEM_PROMPT },
					...(contextMessage ? [{ role: "system", content: contextMessage }] : []),
					{ role: "system", content: TEXT_CHAT_INSTRUCTION },
					...messages,
				],
			}),
			signal: controller.signal,
		});

		if (!upstream.ok) {
			const body = await upstream.text().catch(() => "");
			logger.warn("stib_ai_gateway_error", {
				status: upstream.status,
				body: body.slice(0, 500),
			});
			const message = upstream.status === 429
				? "L'assistant reçoit trop de demandes pour le moment. Réessaie dans quelques secondes."
				: "L'assistant IA est temporairement indisponible. Les données réseau restent disponibles dans l'app.";
			writeSseDelta(res, message);
			writeSseDone(res);
			return res.end();
		}

		if (!upstream.body) {
			return endSse(res);
		}

		upstream.body.on("data", (chunk) => {
			res.write(chunk);
		});
		upstream.body.on("end", () => {
			endSse(res);
		});
		upstream.body.on("error", (error) => {
			logger.warn("stib_ai_stream_error", { message: error.message });
			if (!res.writableEnded) {
				writeSseDelta(res, "\n\nLe flux a été interrompu. Réessaie dans quelques secondes.");
				endSse(res);
			}
		});
	} catch (error) {
		if (error.name !== "AbortError") {
			logger.warn("stib_ai_handler_error", { message: error.message });
			writeSseDelta(res, "Impossible de joindre l'assistant IA pour le moment. Réessaie dans quelques secondes.");
			endSse(res);
		}
		if (!res.writableEnded) res.end();
	}
};

// POST /api/stib-ai/voice
// Single-shot, non-streamed voice handler. Returns JSON {spokenReply, destination?}
// so the iOS layer can play it through AVSpeechSynthesizer and, if a destination
// is detected, trigger the existing trip-building pipeline. Same context builder
// and system prompt as streamChat; one extra hard instruction forcing the model
// to produce a short oral reply with no markdown.
exports.voiceAsk = async (req, res) => {
	const text = String(req.body?.text || "").trim();
	if (!text) {
		return res.status(400).json({ message: "text requis." });
	}

	const key = apiKey();
	if (!key) {
		return res.status(503).json({ message: "L'assistant IA n'est pas configuré." });
	}

	const gatewayUrl = process.env.AI_GATEWAY_URL || DEFAULT_GATEWAY_URL;
	if (!shouldUseGeminiNative(gatewayUrl)) {
		// Voice endpoint only supports the native Gemini gateway (JSON mode).
		return res.status(501).json({ message: "Voice non supporté sur ce gateway." });
	}
	const model = modelForGateway(process.env.AI_MODEL || DEFAULT_MODEL, gatewayUrl);

	const contextMessage = req.body?.context ? buildContextMessage(req.body.context) : "";
	const voiceInstruction = [
		"========================================================",
		"MODE VOIX — RÈGLES SPÉCIFIQUES QUI ÉCRASENT LE PROMPT SYSTÈME",
		"========================================================",
		"",
		"Tu es l'assistant vocal d'une app de TRANSPORT EN COMMUN à Bruxelles. Deux cas :",
		"  • Si la section TRAJET CALCULÉ est présente dans le contexte → tu DOIS décrire ce trajet en détail (lignes, arrêts, durée) avec les badges [[L:NUM]]. Pas de refus, pas de demande de précision.",
		"  • Si elle est absente mais l'utilisateur demande un trajet → réponds brièvement par 'OK, je te cherche ça' (l'app calcule le trajet juste après — on te rappellera avec les vraies données pour la réponse finale).",
		"",
		"⛔️ PHRASES & STYLES STRICTEMENT INTERDITS :",
		"  - 'Je ne trouve pas de trajet…' / 'Je ne peux pas calculer d'itinéraire…'",
		"  - 'cette destination n'est pas reconnue'",
		"  - 'Peux-tu me donner plus de détails / une destination plus précise / une adresse plus précise'",
		"  - 'utilise le planificateur' / 'utiliser le planner'",
		"  - 'je te l'ouvre sur la carte' / 'regarde la carte' / 'tape sur Voir la route'",
		"  - 🚗 INTERDIT ABSOLU — instructions style itinéraire VOITURE :",
		"    'tourne à droite / à gauche', 'prends la rue X', 'continue tout droit',",
		"    'avenue Y', 'rond-point', 'au feu', 'rejoins la N4'. C'est du transport",
		"    en commun, pas Google Maps voiture.",
		"  - Toute formule qui demande à l'utilisateur de reformuler.",
		"",
		"========================================================",
		"FORMAT — tu produis DEUX versions du même message :",
		"========================================================",
		"",
		"1) spokenReply (LU À VOIX HAUTE — la VOIX) :",
		"   - Français parlé, naturel, ton amical (tu). Phrases complètes.",
		"   - Question simple (état, perturbations) : 1-2 phrases, ≤ 30 mots.",
		"   - Demande de trajet SANS TRAJET CALCULÉ : 5-10 mots max, 'OK, je te cherche ça.'",
		"   - Demande de trajet AVEC TRAJET CALCULÉ : 3-5 phrases parlées en clair,",
		"     UNIQUEMENT en termes transport en commun :",
		"     'Pour aller à Delacroix, tu prends la ligne 81 à Bailli direction",
		"      Montgomery, tu descends à Trône, puis cinq minutes de marche.'",
		"     INTERDIT : noms de rues, indications GPS, virages.",
		"   - AUCUN markdown, AUCUN [[L:NUM]], AUCUN emoji.",
		"",
		"2) displayReply (AFFICHÉ À L'ÉCRAN — le TEXTE) :",
		"   - CETTE FOIS tu peux et tu DOIS utiliser le format structuré du prompt",
		"     système (## titre + - puces) pour que le rendu visuel soit aussi",
		"     propre que le chat texte. Format obligatoire dès qu'on décrit un trajet :",
		"",
		"     ## Meilleure option",
		"     - Marche 5 min vers **BAILLI**",
		"     - [[L:81]] direction Montgomery → descends à **TRÔNE** (8 min)",
		"     - Marche 3 min vers **DELACROIX**",
		"",
		"     **Durée totale : 22 min**",
		"",
		"   - Badges [[L:NUM]] OBLIGATOIRES pour chaque ligne STIB réelle (1-100).",
		"   - Arrêts en **MAJUSCULES gras**. Pas de noms de rue.",
		"   - Pas d'emoji.",
		"",
		"3) destination — RÈGLE STRICTE :",
		"   - Si la phrase utilisateur contient une destination → recopie le NOM EXACT",
		"     ('avenue des désirs', 'gare du midi', 'Delacroix'). L'app géocode après.",
		"   - null UNIQUEMENT pour questions sans rapport avec un trajet.",
		"",
		"Retourne UNIQUEMENT un JSON valide conforme au schéma.",
	].join("\n");

	const systemContext = [STIB_AI_SYSTEM_PROMPT, contextMessage, voiceInstruction]
		.filter(Boolean)
		.join("\n\n");

	const baseUrl = gatewayUrl.replace(/\/$/, "");
	const requestBody = JSON.stringify({
		contents: [
			{ role: "user", parts: [{ text: systemContext }] },
			{ role: "user", parts: [{ text: `QUESTION DE L'UTILISATEUR :\n${text}` }] },
		],
		generationConfig: {
			temperature: 0.2,
			topP: 0.9,
			responseMimeType: "application/json",
			responseSchema: {
				type: "object",
				properties: {
					spokenReply: { type: "string" },
					displayReply: { type: "string" },
					destination: { type: "string", nullable: true },
				},
				required: ["spokenReply", "displayReply"],
			},
		},
	});

	const controller = new AbortController();
	req.on("close", () => controller.abort());

	// Gemini 2.5-flash sometimes returns 503 "high demand" — Google explicitly
	// says these spikes are temporary. We retry the same model once with a
	// short backoff, then fall back to 1.5-flash (less loaded) if it still
	// 503s. Anything else is bubbled up immediately.
	async function callModel(modelName) {
		return fetch(`${baseUrl}/models/${encodeURIComponent(modelName)}:generateContent`, {
			method: "POST",
			headers: {
				"x-goog-api-key": key,
				"Content-Type": "application/json",
			},
			body: requestBody,
			signal: controller.signal,
		});
	}

	const fallbackModel = model.includes("2.5") ? "gemini-1.5-flash" : "gemini-1.5-flash";

	try {
		let upstream = await callModel(model);

		if (upstream.status === 503) {
			logger.warn("stib_ai_voice_503_retry", { model });
			await new Promise((r) => setTimeout(r, 700));
			upstream = await callModel(model);
		}
		if (upstream.status === 503 && model !== fallbackModel) {
			logger.warn("stib_ai_voice_503_fallback", { from: model, to: fallbackModel });
			upstream = await callModel(fallbackModel);
		}

		if (!upstream.ok) {
			const body = await upstream.text().catch(() => "");
			logger.warn("stib_ai_voice_upstream_error", {
				status: upstream.status,
				body: body.slice(0, 500),
			});
			if (upstream.status === 503 || upstream.status === 429) {
				return res.status(503).json({
					message: "L'assistant est saturé pour quelques secondes, réessaie tout de suite.",
				});
			}
			return res.status(502).json({ message: "Assistant indisponible." });
		}

		const payload = await upstream.json();
		const raw = payload?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
		let parsed;
		try {
			parsed = JSON.parse(raw);
		} catch (error) {
			logger.warn("stib_ai_voice_parse_error", { raw: raw.slice(0, 300) });
			parsed = { spokenReply: "Je n'ai pas pu te répondre, réessaie.", destination: null };
		}

		const spokenReply = String(parsed.spokenReply || "").trim().slice(0, 800)
			|| "Je n'ai pas pu te répondre, réessaie.";
		const displayReply = String(parsed.displayReply || spokenReply).trim().slice(0, 1200)
			|| spokenReply;
		const destination = parsed.destination && typeof parsed.destination === "string"
			? parsed.destination.trim().slice(0, 200)
			: null;

		return res.json({ spokenReply, displayReply, destination: destination || null });
	} catch (error) {
		if (error.name === "AbortError") return res.end();
		logger.warn("stib_ai_voice_handler_error", { message: error.message });
		return res.status(502).json({ message: "Erreur réseau assistant." });
	}
};
