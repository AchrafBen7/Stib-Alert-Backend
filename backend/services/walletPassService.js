const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const logger = require("./logger");

/**
 * Apple Wallet pass generation for the MoBIB virtual card.
 *
 * REQUIRED ENV VARS (all set on Render before this can succeed):
 *   WALLET_PASS_TYPE_ID       e.g. pass.com.ehb.StibAlert.mobib
 *   WALLET_TEAM_ID            e.g. SLUL8PUP37
 *   WALLET_SIGNER_CERT_PATH   absolute path to signerCert.pem
 *   WALLET_SIGNER_KEY_PATH    absolute path to signerKey.pem
 *   WALLET_SIGNER_KEY_PASS    passphrase for signerKey.pem (or empty)
 *   WALLET_WWDR_PATH          absolute path to wwdr.pem
 *
 * Apple Developer setup (one-time):
 *   1. developer.apple.com → Identifiers → Pass Type IDs → register
 *      pass.com.ehb.StibAlert.mobib
 *   2. Same screen → Create Certificate for that pass type → download .cer
 *   3. In Keychain, export the matching private key + certificate as a .p12
 *   4. openssl pkcs12 -in pass.p12 -clcerts -nokeys -out signerCert.pem
 *      openssl pkcs12 -in pass.p12 -nocerts -out signerKey.pem
 *   5. Download Apple WWDR root cert from apple.com/certificateauthority/
 *      openssl x509 -inform DER -in AppleWWDRCA.cer -out wwdr.pem
 *   6. Upload the three .pem files to backend/certs/ on Render disk
 *      (or commit to repo if you don't mind — they are public-key crypto).
 */

const REQUIRED_VARS = [
	"WALLET_PASS_TYPE_ID",
	"WALLET_TEAM_ID",
	"WALLET_SIGNER_CERT_PATH",
	"WALLET_SIGNER_KEY_PATH",
	"WALLET_WWDR_PATH",
];

function isConfigured() {
	return REQUIRED_VARS.every((name) => Boolean(process.env[name]))
		&& fs.existsSync(process.env.WALLET_SIGNER_CERT_PATH)
		&& fs.existsSync(process.env.WALLET_SIGNER_KEY_PATH)
		&& fs.existsSync(process.env.WALLET_WWDR_PATH);
}

function missingPieces() {
	const missing = REQUIRED_VARS.filter((name) => !process.env[name]);
	const filesMissing = [];
	if (process.env.WALLET_SIGNER_CERT_PATH && !fs.existsSync(process.env.WALLET_SIGNER_CERT_PATH)) {
		filesMissing.push(`signerCert at ${process.env.WALLET_SIGNER_CERT_PATH}`);
	}
	if (process.env.WALLET_SIGNER_KEY_PATH && !fs.existsSync(process.env.WALLET_SIGNER_KEY_PATH)) {
		filesMissing.push(`signerKey at ${process.env.WALLET_SIGNER_KEY_PATH}`);
	}
	if (process.env.WALLET_WWDR_PATH && !fs.existsSync(process.env.WALLET_WWDR_PATH)) {
		filesMissing.push(`wwdr at ${process.env.WALLET_WWDR_PATH}`);
	}
	return { missingEnv: missing, missingFiles: filesMissing };
}

/**
 * Builds the Apple Wallet pass JSON payload for a MoBIB pass. Field naming
 * follows PassKit's "generic" / "storeCard" template — we use storeCard so
 * the user can flip the pass to see fields like card number on the back.
 */
function buildPassJson({ user, pass, serialNumber }) {
	const teamId = process.env.WALLET_TEAM_ID;
	const passTypeId = process.env.WALLET_PASS_TYPE_ID;
	const holder = (pass.holderName || user?.nom || "Titulaire").toUpperCase();
	const cardNumber = pass.cardNumber || "----";
	const subscription = pass.subscriptionLabel || "Abonnement STIB";
	const expiry = pass.expiryDate ? new Date(pass.expiryDate) : null;

	// storeCard layout = carte de membre, le plus proche de la carte MoBIB
	// affichée dans l'app (titre MoBIB, abonnement, titulaire, n°, validité).
	// Couleurs = identité Blayse : orange STIB (la MÊME carte orange que
	// dans Profil → Ma carte STIB), texte blanc, libellés crème chaud.
	return {
		formatVersion: 1,
		passTypeIdentifier: passTypeId,
		teamIdentifier: teamId,
		organizationName: "Blayse",
		description: "Carte de transport MoBIB",
		serialNumber,
		logoText: "MoBIB · STIB-MIVB",
		foregroundColor: "rgb(255, 255, 255)",
		backgroundColor: "rgb(250, 115, 26)", // orange STIB (identité Blayse)
		labelColor: "rgb(255, 224, 196)", // crème chaud, lisible sur l'orange
		expirationDate: expiry ? expiry.toISOString() : undefined,
		storeCard: {
			headerFields: [
				{
					key: "subscription",
					label: "ABONNEMENT",
					value: subscription.toUpperCase(),
				},
			],
			primaryFields: [
				{
					key: "holder",
					label: "TITULAIRE",
					value: holder,
				},
			],
			secondaryFields: [
				{
					key: "cardNumber",
					label: "N° CARTE",
					value: maskCardNumber(cardNumber),
				},
				...(expiry ? [{
					key: "validity",
					label: "VALABLE JUSQU'AU",
					value: expiry.toISOString(),
					dateStyle: "PKDateStyleMedium",
					timeStyle: "PKDateStyleNone",
				}] : []),
			],
			auxiliaryFields: [
				{
					key: "network",
					label: "RÉSEAU",
					value: "STIB-MIVB",
				},
				{
					key: "country",
					label: "PAYS",
					value: "Belgique",
				},
			],
			backFields: [
				{
					key: "fullNumber",
					label: "Numéro de carte (complet)",
					value: cardNumber,
				},
				{
					key: "linkedAccount",
					label: "Compte Blayse",
					value: user?.email || "—",
				},
				{
					key: "notes",
					label: "À propos",
					value: "Représentation visuelle de votre carte MoBIB. Pour valider votre passage, utilisez la carte physique — ce pass est une vue d'ensemble pour retrouver vos infos d'abonnement.",
				},
				{
					key: "support",
					label: "Contact",
					value: "support@stib-alert.be",
				},
			],
		},
	};
}

function maskCardNumber(value) {
	const digits = String(value || "").replace(/\D/g, "");
	if (!digits) return "•••• •••• ••••";
	const last4 = digits.slice(-4).padStart(4, "•");
	return `•••• •••• ${last4}`;
}

/**
 * Generates a signed .pkpass buffer for the given user + saved pass data.
 * Throws if the service is not configured — caller should translate to 503.
 */
async function generateMobibPass({ user, pass }) {
	if (!isConfigured()) {
		const { missingEnv, missingFiles } = missingPieces();
		const err = new Error("Wallet pass service not configured");
		err.code = "WALLET_NOT_CONFIGURED";
		err.details = { missingEnv, missingFiles };
		throw err;
	}

	// passkit-generator is lazy-required so the rest of the backend keeps
	// booting even if the package fails to install on a stale Render image.
	let PKPass;
	try {
		({ PKPass } = require("passkit-generator"));
	} catch (e) {
		const err = new Error("passkit-generator not installed");
		err.code = "WALLET_NOT_INSTALLED";
		throw err;
	}

	const serialNumber = String(user?._id || crypto.randomUUID());
	const passJson = buildPassJson({ user, pass, serialNumber });

	// Load the icon + logo assets — Apple Wallet REQUIRES icon.png (it
	// refuses the pass as "invalid data" otherwise) and a logo improves the
	// pass header. Files live in backend/wallet-assets and are sized to
	// Apple's PassKit recommendations.
	const assetDir = path.join(__dirname, "..", "wallet-assets");
	const files = {
		"pass.json": Buffer.from(JSON.stringify(passJson), "utf8"),
	};
	for (const name of ["icon.png", "icon@2x.png", "icon@3x.png", "logo.png", "logo@2x.png", "logo@3x.png"]) {
		const filePath = path.join(assetDir, name);
		if (fs.existsSync(filePath)) {
			files[name] = fs.readFileSync(filePath);
		}
	}

	const newPass = new PKPass(files, {
		wwdr: fs.readFileSync(process.env.WALLET_WWDR_PATH),
		signerCert: fs.readFileSync(process.env.WALLET_SIGNER_CERT_PATH),
		signerKey: fs.readFileSync(process.env.WALLET_SIGNER_KEY_PATH),
		signerKeyPassphrase: process.env.WALLET_SIGNER_KEY_PASS || undefined,
	});

	const buffer = newPass.getAsBuffer();
	logger.info("[wallet] generated mobib pass", {
		userId: serialNumber,
		bytes: buffer.length,
	});
	return buffer;
}

module.exports = { generateMobibPass, isConfigured, missingPieces };
