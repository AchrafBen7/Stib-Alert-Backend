exports.requireSelf = (paramName = "id") => (req, res, next) => {
	if (!req.user?.userId) {
		return res.status(401).json({ message: "Non authentifié." });
	}
	if (String(req.user.userId) !== String(req.params[paramName])) {
		return res.status(403).json({ message: "Accès refusé : ressource d'un autre utilisateur." });
	}
	next();
};
