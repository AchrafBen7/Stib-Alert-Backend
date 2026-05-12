#!/usr/bin/env node
/**
 * Promotes an existing user to Admin role.
 *
 * Usage:
 *   MONGO_URI=mongodb://... node scripts/promoteAdmin.js admin@example.com
 *
 * The user must already exist (registered + activated).
 */

require("dotenv").config();
const mongoose = require("mongoose");
const Utilisateur = require("../models/Utilisateur");

async function main() {
	const email = process.argv[2];
	if (!email) {
		console.error("Usage: node scripts/promoteAdmin.js <email>");
		process.exit(1);
	}

	const uri = process.env.MONGO_URI;
	if (!uri) {
		console.error("MONGO_URI is required.");
		process.exit(1);
	}

	console.log(`🔌 Connecting to MongoDB...`);
	await mongoose.connect(uri);

	const user = await Utilisateur.findOne({ email: email.toLowerCase().trim() });
	if (!user) {
		console.error(`❌ User not found: ${email}`);
		await mongoose.disconnect();
		process.exit(1);
	}

	if (user.role === "Admin") {
		console.log(`ℹ️  ${email} is already Admin.`);
		await mongoose.disconnect();
		process.exit(0);
	}

	user.role = "Admin";
	await user.save();

	console.log(`✅ Promoted ${email} to Admin`);
	console.log(`   User ID: ${user._id}`);
	console.log(`   Login at /api/utilisateurs/connexion to obtain JWT`);
	console.log(`   Then paste JWT into /admin/moderation/ dashboard`);

	await mongoose.disconnect();
}

main().catch((err) => {
	console.error("Fatal:", err);
	process.exit(1);
});
