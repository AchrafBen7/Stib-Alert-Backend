const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };
const MIN_LEVEL = LEVELS[(process.env.LOG_LEVEL || "info").toLowerCase()] || LEVELS.info;
const IS_PROD = process.env.NODE_ENV === "production";
const SERVICE_NAME = process.env.SERVICE_NAME || "stibalert-backend";
const HOSTNAME = require("os").hostname();

const SENSITIVE_KEYS = new Set([
	"password", "motDePasse", "motdepasse", "token", "refreshtoken", "authorization",
	"jwt", "secret", "apiKey", "api_key", "sessionId", "session_id", "cookie",
	"reporterIpHash", "reporterDeviceHash", "ipHash", "deviceHash",
]);

function sanitize(obj, depth = 0) {
	if (depth > 4) return "[deep]";
	if (obj == null) return obj;
	if (typeof obj !== "object") return obj;
	if (obj instanceof Date) return obj.toISOString();
	if (obj instanceof Error) {
		return { name: obj.name, message: obj.message, stack: IS_PROD ? undefined : obj.stack };
	}
	if (Array.isArray(obj)) return obj.slice(0, 50).map((item) => sanitize(item, depth + 1));

	const out = {};
	for (const key of Object.keys(obj)) {
		if (SENSITIVE_KEYS.has(key.toLowerCase())) {
			out[key] = "[REDACTED]";
		} else {
			out[key] = sanitize(obj[key], depth + 1);
		}
	}
	return out;
}

function emit(level, message, context = {}) {
	if (LEVELS[level] < MIN_LEVEL) return;

	const entry = {
		ts: new Date().toISOString(),
		level,
		service: SERVICE_NAME,
		host: HOSTNAME,
		msg: message,
		...sanitize(context),
	};

	if (IS_PROD) {
		process.stdout.write(JSON.stringify(entry) + "\n");
	} else {
		const fn = level === "error" || level === "fatal" ? console.error : console.log;
		fn(`[${entry.ts}] ${level.toUpperCase()} ${message}`, Object.keys(context).length > 0 ? sanitize(context) : "");
	}
}

const logger = {
	trace: (msg, ctx) => emit("trace", msg, ctx),
	debug: (msg, ctx) => emit("debug", msg, ctx),
	info: (msg, ctx) => emit("info", msg, ctx),
	warn: (msg, ctx) => emit("warn", msg, ctx),
	error: (msg, ctx) => emit("error", msg, ctx),
	fatal: (msg, ctx) => emit("fatal", msg, ctx),

	child(bindings = {}) {
		return new Proxy(this, {
			get(target, prop) {
				if (LEVELS[prop] !== undefined) {
					return (msg, ctx = {}) => target[prop](msg, { ...bindings, ...ctx });
				}
				return target[prop];
			},
		});
	},

	requestMiddleware() {
		return (req, res, next) => {
			const start = Date.now();
			const reqId = req.headers["x-request-id"] || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			req.logger = logger.child({ reqId, method: req.method, path: req.path });

			res.on("finish", () => {
				const durationMs = Date.now() - start;
				const ctx = {
					reqId,
					method: req.method,
					path: req.path,
					status: res.statusCode,
					durationMs,
					ua: req.headers["user-agent"]?.slice(0, 80),
				};
				if (res.statusCode >= 500) logger.error("request_failed", ctx);
				else if (res.statusCode >= 400) logger.warn("request_client_error", ctx);
				else logger.info("request_ok", ctx);
			});

			next();
		};
	},
};

module.exports = logger;
