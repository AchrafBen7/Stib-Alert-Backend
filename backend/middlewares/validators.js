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
		"Contrôle",
		"Affluence",
		"Retard",
		"Accident",
		"Panne",
		"Propreté",
		"Agression",
		"Incivilité",
		"Travaux",
		"Déviation",
		"Interruption",
		"Arrêt non desservi",
		"Perturbation",
		"Information STIB",
		"Autre",
	]),
	body("description").trim().isLength({ min: 3, max: 500 }),
	body("latitude").optional().isFloat({ min: -90, max: 90 }),
	body("longitude").optional().isFloat({ min: -180, max: 180 }),
	body("transportOperator").optional().trim().isIn(["stib", "delijn", "sncb", "tec"]),
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
	body("oneSignalPlayerId")
		.optional()
		.trim()
		.isLength({ min: 8, max: 256 })
		.withMessage("OneSignal player id invalide"),
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
		if (!value?.tokenPush && !value?.tokenFCM && !value?.oneSignalPlayerId) {
			throw new Error("Token push ou player id requis");
		}
		return true;
	}),
];

exports.validateProfileUpdate = [
	body("nom").optional().trim().isLength({ min: 2, max: 60 }).withMessage("Nom invalide"),
	body("langue").optional().isIn(["FR", "NL", "EN"]).withMessage("Langue invalide"),
	body("notifications").optional().isBoolean().withMessage("Notifications invalides"),
	body("weeklyDigestEnabled").optional().isBoolean().withMessage("Préférence digest invalide"),
	body("favoriteLines").optional().isArray({ max: 8 }).withMessage("Lignes favorites invalides"),
	body("favoriteLines.*").optional().trim().isLength({ min: 1, max: 10 }).withMessage("Ligne favorite invalide"),
	body("routine").optional().isObject().withMessage("Routine invalide"),
	body("routine.enabled").optional().isBoolean().withMessage("Routine enabled invalide"),
	body("routine.homeLabel").optional().trim().isLength({ min: 1, max: 80 }).withMessage("Libellé domicile invalide"),
	body("routine.workLabel").optional().trim().isLength({ min: 1, max: 80 }).withMessage("Libellé travail invalide"),
	body("routine.departureTime").optional().matches(/^\d{2}:\d{2}$/).withMessage("Heure de départ invalide"),
	body("routine.homeStopId").optional({ nullable: true }).custom((value) => value === null || /^[a-fA-F0-9]{24}$/.test(String(value))).withMessage("Arrêt domicile invalide"),
	body("routine.workStopId").optional({ nullable: true }).custom((value) => value === null || /^[a-fA-F0-9]{24}$/.test(String(value))).withMessage("Arrêt travail invalide"),
];
