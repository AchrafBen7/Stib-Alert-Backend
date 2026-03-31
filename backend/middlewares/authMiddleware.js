const jwt = require("jsonwebtoken");
const redis = require("../config/redis");

// ✅ Middleware pour protéger les routes
const protect = async (req, res, next) => {
	try {
		let token;

		// Vérifie si le token est envoyé dans l'Authorization Header
		if (req.headers.authorization && req.headers.authorization.startsWith("Bearer ")) {
			token = req.headers.authorization.split(" ")[1];
		}

		if (!token) {
			return res.status(401).json({ message: "Accès refusé. Aucun token fourni." });
		}

		// Vérifie si le token est dans Redis (cache)
		if (redis) {
			const cacheUser = await redis.get(`auth:${token}`);
			if (cacheUser) {
				req.user = JSON.parse(cacheUser); // Récupère les données mises en cache
				return next();
			}
		}

		// Vérifie et décode le token JWT
		const decoded = jwt.verify(token, process.env.JWT_SECRET);
		req.user = { userId: decoded.userId };

		// Stocke les infos de l'utilisateur dans Redis (expire après 7 jours)
		if (redis) {
			await redis.setex(`auth:${token}`, 604800, JSON.stringify(req.user));
		}

		next();
	} catch (error) {
		res.status(401).json({ message: "Token invalide ou expiré." });
	}
};

module.exports = protect;
