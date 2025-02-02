const Redis = require("ioredis");
require("dotenv").config();

let redis;

const connectRedis = () => {
	try {
		if (process.env.REDIS_URL) {
			redis = new Redis(process.env.REDIS_URL);
			console.log("Redis connected successfully");
		} else {
			throw new Error("REDIS_URL not provided in .env");
		}
	} catch (error) {
		console.error("Redis connection failed:", error.message);
		setTimeout(connectRedis, 5000); // Retry connection every 5 seconds
	}
};

// Call the function to connect to Redis
connectRedis();

module.exports = redis; // Export the Redis client instance
