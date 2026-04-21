const rateLimit = require("express-rate-limit");

const makeLimiter = (windowMs, max, message) =>
	rateLimit({
		windowMs,
		max,
		standardHeaders: true,
		legacyHeaders: false,
		message: { message },
	});

exports.authLimiter = makeLimiter(
	15 * 60 * 1000,
	10,
	"Trop de tentatives d'authentification. Réessayez dans 15 minutes."
);

exports.signalementLimiter = makeLimiter(
	60 * 1000,
	5,
	"Trop de signalements. Attendez une minute."
);

exports.chatbotLimiter = makeLimiter(
	60 * 1000,
	10,
	"Trop de requêtes au chatbot. Attendez une minute."
);

exports.globalLimiter = makeLimiter(
	60 * 1000,
	120,
	"Trop de requêtes, réessayez dans un instant."
);
