const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const fetch = require("node-fetch");
const logger = require("./logger");

const APPLE_KEYS_URL = "https://appleid.apple.com/auth/keys";
const APPLE_ISSUER = "https://appleid.apple.com";
// Set on Render to your iOS bundle identifier (com.ehb.StibAlert) so we can
// reject tokens issued to a different app.
const EXPECTED_AUDIENCE = process.env.APPLE_SIGN_IN_AUDIENCE || "com.ehb.StibAlert";

let keysCache = { keys: null, fetchedAt: 0 };
const KEYS_TTL_MS = 60 * 60 * 1000; // 1h — Apple rotates rarely; refresh on miss anyway.

async function fetchApplePublicKeys() {
	const now = Date.now();
	if (keysCache.keys && now - keysCache.fetchedAt < KEYS_TTL_MS) {
		return keysCache.keys;
	}
	const response = await fetch(APPLE_KEYS_URL, { timeout: 5000 });
	if (!response.ok) {
		throw new Error(`Apple JWKS endpoint returned ${response.status}`);
	}
	const body = await response.json();
	keysCache = { keys: body.keys || [], fetchedAt: now };
	return keysCache.keys;
}

function jwkToPem(jwk) {
	// jsonwebtoken accepts a KeyObject built from a JWK directly on Node 16+.
	return crypto.createPublicKey({ key: jwk, format: "jwk" });
}

/**
 * Validates the identity token issued by Sign in with Apple on iOS.
 * Returns { sub, email } on success, throws an Error on any failure.
 *
 * Apple's identity token is a JWS signed with RS256. We:
 *   1. Decode the header to find the `kid` of the signing key.
 *   2. Fetch Apple's public JWKS (cached 1h) and pick the matching key.
 *   3. Verify the signature + standard claims (iss, aud, exp).
 *   4. Return the relevant fields for our auth flow.
 */
async function verifyAppleIdentityToken(identityToken) {
	if (!identityToken || typeof identityToken !== "string") {
		throw new Error("identity_token missing");
	}

	const decodedHeader = jwt.decode(identityToken, { complete: true })?.header;
	if (!decodedHeader?.kid) {
		throw new Error("identity_token header has no kid");
	}

	const keys = await fetchApplePublicKeys();
	let key = keys.find((k) => k.kid === decodedHeader.kid);
	if (!key) {
		// Apple may have rotated keys since our cache: force refresh once.
		keysCache.fetchedAt = 0;
		const refreshed = await fetchApplePublicKeys();
		key = refreshed.find((k) => k.kid === decodedHeader.kid);
	}
	if (!key) {
		throw new Error(`no matching Apple signing key for kid ${decodedHeader.kid}`);
	}

	const publicKey = jwkToPem(key);
	const payload = jwt.verify(identityToken, publicKey, {
		algorithms: ["RS256"],
		issuer: APPLE_ISSUER,
		audience: EXPECTED_AUDIENCE,
	});

	if (!payload.sub) {
		throw new Error("Apple token missing sub claim");
	}

	return {
		sub: payload.sub,
		email: typeof payload.email === "string" ? payload.email.toLowerCase() : null,
		emailVerified: payload.email_verified === true || payload.email_verified === "true",
		isPrivateRelay: payload.is_private_email === true || payload.is_private_email === "true",
	};
}

module.exports = { verifyAppleIdentityToken };
