module.exports = (req, res, next) => {
	if (!req.user || req.user.role !== "Admin") {
		return res.status(403).json({ message: "❌ Accès refusé. Seuls les administrateurs peuvent effectuer cette action." });
	}
	next();
};
