require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const connectDB = require("./config/db");

const app = express();

// Middlewares
app.use(express.json());
app.use(cors());
app.use(helmet());
app.use(morgan("dev"));

app.use("/api/signalements", require("./routes/signalementRoutes"));

// Route de test
app.get("/", (req, res) => {
	res.send("STIB Alert API fonctionne !");
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, async () => {
	await connectDB();
	console.log(`Serveur en cours sur http://localhost:${PORT}`);
});
