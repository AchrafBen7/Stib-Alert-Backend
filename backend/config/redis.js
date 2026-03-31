const Redis = require("ioredis");
require("dotenv").config();

if (!process.env.REDIS_URL) {
	module.exports = null;
	return;
}

const redis = new Redis(process.env.REDIS_URL, {
	maxRetriesPerRequest: 1,
	enableReadyCheck: true,
});

redis.on("connect", () => {
	console.log("Redis connected successfully");
});

redis.on("error", (error) => {
	console.error("Redis connection failed:", error.message);
});

module.exports = redis;
