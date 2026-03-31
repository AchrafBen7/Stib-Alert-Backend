const mongoose = require("mongoose");
require("dotenv").config();

const dbUrl = process.env.MONGO_URI || "";
let retryTimer = null;

mongoose.set("bufferCommands", false);

function hasValidMongoScheme(url) {
	return url.startsWith("mongodb://") || url.startsWith("mongodb+srv://");
}

function scheduleReconnect() {
	if (retryTimer) return;
	retryTimer = setTimeout(() => {
		retryTimer = null;
		connectDB();
	}, 5000);
}

const connectDB = async () => {
	if (mongoose.connection.readyState === 1) {
		return true;
	}

	if (!dbUrl) {
		console.warn("⚠️ MONGO_URI est vide. MongoDB n'est pas configuré.");
		return false;
	}

	if (!hasValidMongoScheme(dbUrl)) {
		console.warn('⚠️ MONGO_URI invalide. Utilise un URI qui commence par "mongodb://" ou "mongodb+srv://".');
		return false;
	}

	try {
		const data = await mongoose.connect(dbUrl, {
			serverSelectionTimeoutMS: 3000,
		});
		console.log(`Database connected with ${data.connection.host}`);
		return true;
	} catch (error) {
		console.error("❌ MongoDB connection failed:", error.message);
		scheduleReconnect();
		return false;
	}
};

module.exports = connectDB;
