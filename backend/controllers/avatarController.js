// Avatar upload — réutilise la même config Cloudinary que les photos de
// signalements. Pattern miroir de signalementController.upload avec un
// dossier dédié + transformation carrée 256x256 pour économiser le bandwidth
// quand l'app affiche la miniature dans le profile header.

const cloudinary = require("../config/cloudinary");
const { CloudinaryStorage } = require("multer-storage-cloudinary");
const multer = require("multer");
const Utilisateur = require("../models/Utilisateur");

const avatarStorage = new CloudinaryStorage({
	cloudinary,
	params: {
		folder: "stib-alert/avatars",
		allowed_formats: ["jpg", "jpeg", "png"],
		// Crop carré 256x256 — le profile affiche un cercle 48 pt @3x = 144 px,
		// 256 px laisse de la marge pour Retina + futur usage dans liste
		// d'amis. Bandwidth max ~30 ko par avatar.
		transformation: [
			{ width: 256, height: 256, crop: "fill", gravity: "face", quality: "auto:good" },
		],
	},
});

exports.uploadMiddleware = multer({
	storage: avatarStorage,
	fileFilter(req, file, cb) {
		const allowed = ["image/jpeg", "image/jpg", "image/png"];
		if (!allowed.includes(file.mimetype)) {
			return cb(new Error("Seuls JPEG et PNG sont autorisés."), false);
		}
		cb(null, true);
	},
	limits: {
		fileSize: 5 * 1024 * 1024, // 5 MB max — Cloudinary refuse au-delà de toute façon
	},
}).single("avatar");

/**
 * POST /api/utilisateurs/me/avatar — multipart form-data avec champ "avatar".
 * Renvoie l'utilisateur complet à jour pour que l'iOS rafraîchisse son
 * session.currentUser immédiatement.
 */
exports.uploadAvatar = async (req, res) => {
	try {
		if (!req.file) {
			return res.status(400).json({ message: "Aucun fichier reçu. Champ 'avatar' attendu." });
		}
		const userId = req.user?.id;
		if (!userId) {
			return res.status(401).json({ message: "Authentification requise." });
		}

		const newUrl = req.file.path; // Cloudinary renvoie une URL https://res.cloudinary.com/...

		const user = await Utilisateur.findByIdAndUpdate(
			userId,
			{ $set: { photoProfil: newUrl } },
			{ new: true, select: "-motDePasse" }
		);

		if (!user) {
			return res.status(404).json({ message: "Compte introuvable." });
		}

		return res.json({ utilisateur: user });
	} catch (error) {
		console.error("[avatar.upload]", error);
		return res.status(500).json({ message: "Erreur lors de l'upload de l'avatar." });
	}
};

/**
 * DELETE /api/utilisateurs/me/avatar — efface l'avatar (retour à l'initiale).
 */
exports.deleteAvatar = async (req, res) => {
	try {
		const userId = req.user?.id;
		if (!userId) {
			return res.status(401).json({ message: "Authentification requise." });
		}
		const user = await Utilisateur.findByIdAndUpdate(
			userId,
			{ $unset: { photoProfil: "" } },
			{ new: true, select: "-motDePasse" }
		);
		if (!user) {
			return res.status(404).json({ message: "Compte introuvable." });
		}
		return res.json({ utilisateur: user });
	} catch (error) {
		console.error("[avatar.delete]", error);
		return res.status(500).json({ message: "Erreur lors de la suppression de l'avatar." });
	}
};
