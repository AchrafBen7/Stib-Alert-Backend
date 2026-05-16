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

	return {
		formatVersion: 1,
		passTypeIdentifier: passTypeId,
		teamIdentifier: teamId,
		organizationName: "StibAlert",
		description: "Carte de transport MoBIB",
		serialNumber,
		logoText: "MoBIB",
		foregroundColor: "rgb(255, 255, 255)",
		backgroundColor: "rgb(36, 63, 115)", // STIB navy
		labelColor: "rgb(255, 200, 56)",
		storeCard: {
			primaryFields: [
				{
					key: "subscription",
					label: "ABONNEMENT",
					value: subscription,
				},
			],
			secondaryFields: [
				{
					key: "holder",
					label: "TITULAIRE",
					value: holder,
				},
				...(expiry ? [{
					key: "expiry",
					label: "EXPIRATION",
					value: expiry.toISOString(),
					dateStyle: "PKDateStyleMedium",
					timeStyle: "PKDateStyleNone",
				}] : []),
			],
			auxiliaryFields: [
				{
					key: "cardNumber",
					label: "N° CARTE",
					value: maskCardNumber(cardNumber),
				},
				{
					key: "network",
					label: "RÉSEAU",
					value: "STIB · MIVB",
				},
			],
			backFields: [
				{
					key: "fullNumber",
					label: "Numéro complet",
					value: cardNumber,
				},
				{
					key: "linkedAccount",
					label: "Compte associé",
					value: user?.email || "—",
				},
				{
					key: "notes",
					label: "À propos",
					value: "Représentation visuelle de votre carte MoBIB STIB. Pour valider votre passage, utilisez la carte physique. Cette carte numérique facilite le suivi de votre abonnement dans StibAlert.",
				},
				{
					key: "support",
					label: "Support",
					value: "support@stibalert.app",
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

	const newPass = new PKPass({
		"pass.json": Buffer.from(JSON.stringify(passJson), "utf8"),
	}, {
		wwdr: fs.readFileSync(process.env.WALLET_WWDR_PATH),
		signerCert: fs.readFileSync(process.env.WALLET_SIGNER_CERT_PATH),
		signerKey: fs.readFileSync(process.env.WALLET_SIGNER_KEY_PATH),
		signerKeyPassphrase: process.env.WALLET_SIGNER_KEY_PASS || undefined,
	});

	// No icons embedded — Wallet shows a generic icon if missing, which is
	// acceptable for v1. Drop icon.png / logo.png in backend/certs/wallet/
	// later and load them here via newPass.addBuffer("icon.png", ...) for a
	// branded look.

	const buffer = newPass.getAsBuffer();
	logger.info("[wallet] generated mobib pass", {
		userId: serialNumber,
		bytes: buffer.length,
	});
	return buffer;
}

module.exports = { generateMobibPass, isConfigured, missingPieces };
