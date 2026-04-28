const rateLimit = require("express-rate-limit");

const makeLimiter = (windowMs, max, message) =>
	rateLimit({
		windowMs,
		max,
		standardHeaders: true,
		legacyHeaders: false,
		message: { message },
	});

const makeAuthLimiter = (windowMs, max, message) =>
	rateLimit({
		windowMs,
		max,
		standardHeaders: true,
		legacyHeaders: false,
		skipSuccessfulRequests: true,
		message: { message },
	});

exports.signupLimiter = makeLimiter(
	15 * 60 * 1000,
	5,
	"Trop de tentatives d'inscription. Réessayez dans 15 minutes."
);

exports.activationLimiter = makeAuthLimiter(
	15 * 60 * 1000,
	12,
	"Trop de tentatives d'activation. Réessayez dans 15 minutes."
);

exports.loginLimiter = makeAuthLimiter(
	15 * 60 * 1000,
	20,
	"Trop de tentatives de connexion. Réessayez dans 15 minutes."
);

exports.refreshLimiter = makeAuthLimiter(
	15 * 60 * 1000,
	40,
	"Trop de rafraichissements de session. Réessayez dans quelques minutes."
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
