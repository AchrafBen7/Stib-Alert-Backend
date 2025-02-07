const express = require("express");
const { chatbot } = require("../controllers/chatbotController");
const router = express.Router();

// ✅ Endpoint pour poser une question au chatbot
router.post("/", chatbot);

module.exports = router;
