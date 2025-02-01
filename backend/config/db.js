const mongoose = require("mongoose");
require("dotenv").config();

const dbUrl = process.env.MONGO_URI || "";

const connectDB = async () => {
	try {
		const data = await mongoose.connect(dbUrl);
		console.log(`Database connected with ${data.connection.host}`);
	} catch (error) {
		console.log(error.message);
		setTimeout(connectDB, 5000);
	}
};

module.exports = connectDB;
