const rateLimit = require("express-rate-limit");

const isTest = () => process.env.NODE_ENV === "test";

const makeLimiter = (windowMs, max, message) =>
	rateLimit({
		windowMs,
		max,
		standardHeaders: true,
		legacyHeaders: false,
		skip: isTest,
		message: { message },
	});

const makeConditionalLimiter = ({ windowMs, max, message, skip }) =>
	rateLimit({
		windowMs,
		max,
		standardHeaders: true,
		legacyHeaders: false,
		skip: (req) => isTest() || (skip ? skip(req) : false),
		message: { message },
	});

const makeAuthLimiter = (windowMs, max, message) =>
	rateLimit({
		windowMs,
		max,
		standardHeaders: true,
		legacyHeaders: false,
		skipSuccessfulRequests: true,
		skip: isTest,
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

exports.anonymousSignalementLimiter = makeConditionalLimiter({
	windowMs: 15 * 60 * 1000,
	max: 3,
	message: "Trop de signalements anonymes. Réessayez plus tard ou connectez-vous.",
	skip: (req) => Boolean(req.user?.userId),
});

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
