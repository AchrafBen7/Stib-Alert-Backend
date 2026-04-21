const { body, param, validationResult } = require("express-validator");

exports.handleValidation = (req, res, next) => {
	const errors = validationResult(req);
	if (!errors.isEmpty()) {
		return res.status(400).json({
			message: "Validation échouée",
			errors: errors.array().map((e) => ({ field: e.path, msg: e.msg })),
		});
	}
	next();
};

exports.validateSignup = [
	body("nom").trim().isLength({ min: 2, max: 60 }).withMessage("Nom invalide"),
	body("email").trim().isEmail().normalizeEmail().withMessage("Email invalide"),
	body("motDePasse")
		.isLength({ min: 8, max: 128 })
		.withMessage("Mot de passe: 8 à 128 caractères"),
];

exports.validateLogin = [
	body("email").trim().isEmail().normalizeEmail().withMessage("Email invalide"),
	body("motDePasse").isLength({ min: 1, max: 128 }).withMessage("Mot de passe requis"),
];

exports.validateActivation = [
	body("activationToken").isString().notEmpty(),
	body("activationCode").isString().isLength({ min: 4, max: 4 }),
];

exports.validateSignalement = [
	body("nomArret").trim().isLength({ min: 1, max: 120 }),
	body("ligne").trim().isLength({ min: 1, max: 10 }),
	body("typeProbleme").isIn([
		"Retard",
		"Accident",
		"Panne",
		"Propreté",
		"Agression",
		"Incivilité",
		"Autre",
	]),
	body("description").trim().isLength({ min: 3, max: 500 }),
	body("latitude").optional().isFloat({ min: -90, max: 90 }),
	body("longitude").optional().isFloat({ min: -180, max: 180 }),
];

exports.validateVote = [
	param("id").isMongoId(),
	body("vote").isIn(["up", "down"]),
];

exports.validateMongoId = [param("id").isMongoId()];

exports.validateFavori = [
	param("id").isMongoId(),
	param("arretId").isMongoId(),
];

exports.validatePushToken = [
	body("tokenPush")
		.optional()
		.trim()
		.isLength({ min: 20, max: 4096 })
		.withMessage("Token push invalide"),
	body("tokenFCM")
		.optional()
		.trim()
		.isLength({ min: 20, max: 4096 })
		.withMessage("Token push invalide"),
	body().custom((value) => {
		if (!value?.tokenPush && !value?.tokenFCM) {
			throw new Error("Token push requis");
		}
		return true;
	}),
];
