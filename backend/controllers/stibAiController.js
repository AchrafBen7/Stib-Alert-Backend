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

function startSse(res) {
	res.status(200);
	res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
	res.setHeader("Cache-Control", "no-cache, no-transform");
	res.setHeader("Connection", "keep-alive");
	res.setHeader("X-Accel-Buffering", "no");
	if (typeof res.flushHeaders === "function") res.flushHeaders();
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

function geminiContents(messages, contextMessage) {
	const systemContext = [STIB_AI_SYSTEM_PROMPT, contextMessage].filter(Boolean).join("\n\n");
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

async function streamGeminiNative({ gatewayUrl, model, key, messages, contextMessage, controller, req, res }) {
	const upstream = await fetch(geminiNativeUrl(gatewayUrl, model), {
		method: "POST",
		headers: {
			"x-goog-api-key": key,
			"Content-Type": "application/json",
			Accept: "text/event-stream",
		},
		body: JSON.stringify({
			contents: geminiContents(messages, contextMessage),
			generationConfig: {
				temperature: 0.35,
				topP: 0.9,
			},
		}),
		signal: controller.signal,
	});

	if (!upstream.ok) {
		const body = await upstream.text().catch(() => "");
		logger.warn("stib_ai_gemini_error", {
			status: upstream.status,
			body: body.slice(0, 500),
		});
		const message = upstream.status === 429
			? "L'assistant reçoit trop de demandes pour le moment. Réessaie dans quelques secondes."
			: "L'assistant IA Gemini est temporairement indisponible. Vérifie la clé API ou le modèle configuré.";
		writeSseDelta(res, message);
		writeSseDone(res);
		return res.end();
	}

	if (!upstream.body) {
		writeSseDone(res);
		return res.end();
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
		if (!req.destroyed && !res.writableEnded) writeSseDone(res);
		res.end();
	});
	upstream.body.on("error", (error) => {
		logger.warn("stib_ai_gemini_stream_error", { message: error.message });
		if (!res.writableEnded) {
			writeSseDelta(res, "\n\nLe flux Gemini a été interrompu. Réessaie dans quelques secondes.");
			writeSseDone(res);
			res.end();
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

	req.on("close", () => {
		controller.abort();
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
				req,
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
			writeSseDone(res);
			return res.end();
		}

		upstream.body.on("data", (chunk) => {
			res.write(chunk);
		});
		upstream.body.on("end", () => {
			res.end();
		});
		upstream.body.on("error", (error) => {
			logger.warn("stib_ai_stream_error", { message: error.message });
			if (!res.writableEnded) {
				writeSseDelta(res, "\n\nLe flux a été interrompu. Réessaie dans quelques secondes.");
				writeSseDone(res);
				res.end();
			}
		});
	} catch (error) {
		if (error.name !== "AbortError") {
			logger.warn("stib_ai_handler_error", { message: error.message });
			writeSseDelta(res, "Impossible de joindre l'assistant IA pour le moment. Réessaie dans quelques secondes.");
			writeSseDone(res);
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
		"FORMAT OBLIGATOIRE — tu produis DEUX versions du même message :",
		"",
		"1) spokenReply (LU À VOIX HAUTE) :",
		"   - Français parlé, naturel, ton amical (tu).",
		"   - Question simple : 1-2 phrases, ≤ 30 mots.",
		"   - Itinéraire : 3-5 phrases, ≤ 80 mots, étape par étape (arrêts + lignes prononcés en clair, ex: 'tu prends la ligne 81 jusqu'à Schaerbeek').",
		"   - Si l'utilisateur demande un trajet ET qu'aucun TRAJET CALCULÉ n'est dans le contexte : NE refuse PAS. Dis simplement quelque chose comme 'Je cherche un itinéraire vers <lieu>, je te l'ouvre sur la carte.' L'app va géocoder et calculer le trajet ensuite — tu n'as pas besoin de connaître le lieu.",
		"   - AUCUN markdown, AUCUN [[L:NUM]], AUCUN emoji, AUCUN astérisque.",
		"",
		"2) displayReply (AFFICHÉ À L'ÉCRAN, mêmes phrases mais enrichies) :",
		"   - MÊME contenu que spokenReply, mais chaque code de ligne STIB doit être mis dans le marqueur [[L:NUMÉRO]] pour qu'il s'affiche en badge coloré. Exemple : 'Tu prends la [[L:81]] direction Montgomery, puis la [[L:7]] jusqu'à Schaerbeek.'",
		"   - Pas de markdown lourd, pas d'astérisque, pas de listes à puces (les phrases naturelles suffisent).",
		"   - Ne mets [[L:NUM]] QUE pour des numéros de ligne STIB réels (1-100), jamais pour des durées, arrêts ou autres.",
		"",
		"3) destination — RÈGLE STRICTE :",
		"   - Si la phrase de l'utilisateur contient une destination (ex: 'route vers X', 'je vais à X', 'comment aller à X', 'itinéraire pour X', 'amène-moi à X') → recopie LE NOM EXACT entendu (ex: 'avenue des désirs', 'gare du midi', 'place Flagey', 'Atomium').",
		"   - Tu NE dois PAS juger si le lieu existe ou si tu le connais — le géocodage est fait par l'app iOS (MKLocalSearch sur Bruxelles). Renvoie toujours la chaîne brute.",
		"   - Mets null UNIQUEMENT si la question n'a aucun rapport avec un trajet (ex: 'quel est l'état des lignes', 'y a-t-il des perturbations').",
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
			temperature: 0.4,
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
