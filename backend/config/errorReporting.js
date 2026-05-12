/**
 * Production error reporting wrapper.
 *
 * Today: structured logging via services/logger. Plug-in points are wired so
 * adding Sentry / Bugsnag / Highlight later is a one-file change — no need to
 * touch every catch block in the codebase.
 *
 * To enable Sentry later:
 *   npm install @sentry/node
 *   set SENTRY_DSN in env
 *   uncomment the Sentry block below
 */

const logger = require("../services/logger");

let initialized = false;
let provider = "logger";

function init() {
	if (initialized) return;
	initialized = true;

	if (process.env.SENTRY_DSN) {
		try {
			// Uncomment after `npm install @sentry/node`:
			// const Sentry = require("@sentry/node");
			// Sentry.init({
			//   dsn: process.env.SENTRY_DSN,
			//   environment: process.env.NODE_ENV || "development",
			//   tracesSampleRate: 0.1,
			//   profilesSampleRate: 0.0,
			//   release: process.env.SERVICE_VERSION || "stibalert-backend@dev",
			// });
			// provider = "sentry";
			// console.log("✅ Sentry initialized");
		} catch (e) {
			logger.warn("sentry_init_failed", { message: e.message });
		}
	}

	process.on("unhandledRejection", (reason, promise) => {
		captureError(reason instanceof Error ? reason : new Error(String(reason)), {
			tag: "unhandledRejection",
		});
	});

	process.on("uncaughtException", (err) => {
		captureError(err, { tag: "uncaughtException", fatal: true });
		// Let the process crash so the orchestrator restarts it.
		setTimeout(() => process.exit(1), 100);
	});
}

function captureError(error, context = {}) {
	const message = error?.message || String(error);
	const stack = error?.stack;

	logger.error("captured_error", {
		message,
		stack: process.env.NODE_ENV === "production" ? undefined : stack,
		...context,
	});

	// Future:
	// if (provider === "sentry") {
	//   const Sentry = require("@sentry/node");
	//   Sentry.captureException(error, { tags: context });
	// }
}

function captureMessage(message, context = {}) {
	logger.warn("captured_message", { message, ...context });
}

function expressMiddleware() {
	return (err, req, res, next) => {
		captureError(err, {
			method: req.method,
			path: req.path,
			ip: req.ip,
			userId: req.user?.userId,
		});
		next(err);
	};
}

module.exports = {
	init,
	captureError,
	captureMessage,
	expressMiddleware,
};
