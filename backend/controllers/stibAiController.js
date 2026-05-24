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
