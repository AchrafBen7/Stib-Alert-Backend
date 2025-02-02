const nodemailer = require("nodemailer");
require("dotenv").config();

const transporter = nodemailer.createTransport({
	host: process.env.SMTP_HOST,
	port: process.env.SMTP_PORT,
	secure: process.env.SMTP_PORT === "465", // true pour 465, false pour 587
	auth: {
		user: process.env.SMTP_MAIL,
		pass: process.env.SMTP_PASSWORD,
	},
});

const sendMail = async (to, subject, html) => {
	try {
		const mailOptions = {
			from: process.env.SMTP_MAIL,
			to,
			subject,
			html,
		};

		await transporter.sendMail(mailOptions);
		console.log(`📧 Email envoyé à ${to}`);
	} catch (error) {
		console.error("❌ Erreur lors de l'envoi de l'email :", error);
		throw new Error("L'envoi de l'email a échoué");
	}
};

module.exports = sendMail;
