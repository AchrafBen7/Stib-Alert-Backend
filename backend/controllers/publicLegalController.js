// Pages HTML publiques pour App Store Connect.
// Apple exige une URL HTML publique pour la privacy policy + un support
// URL accessibles sans authentification. On les sert directement depuis
// Express plutôt que de monter un GitHub Pages séparé — plus simple à
// maintenir, mêmes données que /api/utilisateurs/privacy/policy.

const PRIVACY_EMAIL = process.env.PRIVACY_EMAIL || "privacy@stibalert.com";
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || "support@stibalert.com";

const baseStyle = `
	html, body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #1c1c1e; background: #fdfaf3; line-height: 1.55; }
	.container { max-width: 760px; margin: 0 auto; padding: 32px 24px 80px; }
	.header { border-bottom: 2px solid #1c1c1e; padding-bottom: 16px; margin-bottom: 32px; }
	.eyebrow { font-size: 11px; letter-spacing: 1.5px; font-weight: 700; color: #888; text-transform: uppercase; }
	h1 { font-size: 32px; font-weight: 800; margin: 8px 0 0; letter-spacing: -0.6px; }
	h2 { font-size: 20px; font-weight: 700; margin: 32px 0 12px; }
	h3 { font-size: 15px; font-weight: 700; margin: 18px 0 6px; color: #444; }
	p { font-size: 14.5px; margin: 8px 0; }
	ul { padding-left: 22px; font-size: 14.5px; }
	li { margin: 4px 0; }
	a { color: #d63a3f; text-decoration: none; font-weight: 600; }
	a:hover { text-decoration: underline; }
	.notice { background: #fff3cd; border-left: 4px solid #ffb85f; padding: 14px 18px; border-radius: 4px; margin: 18px 0; font-size: 13.5px; }
	.contact { background: #f3f3f3; padding: 16px 18px; border-radius: 8px; margin-top: 28px; }
	.footer { margin-top: 56px; padding-top: 18px; border-top: 1px solid #ddd; font-size: 12px; color: #888; }
`;

exports.privacyHTML = (req, res) => {
	const lastUpdated = new Date().toISOString().slice(0, 10);
	const html = `<!doctype html>
<html lang="fr">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width,initial-scale=1" />
	<title>Politique de confidentialité — StibAlert</title>
	<style>${baseStyle}</style>
</head>
<body>
	<div class="container">
		<div class="header">
			<div class="eyebrow">StibAlert · Bruxelles</div>
			<h1>Politique de confidentialité</h1>
			<p style="margin-top: 12px; color: #888; font-size: 13px;">Dernière mise à jour : ${lastUpdated}</p>
		</div>

		<div class="notice">
			<strong>Application indépendante.</strong> StibAlert n'est ni produite, ni endossée, ni affiliée à STIB-MIVB, SNCB, De Lijn ou TEC. Les marques citées appartiennent à leurs propriétaires respectifs.
		</div>

		<h2>1. Qui est responsable du traitement ?</h2>
		<p>StibAlert est une application développée par Achraf Benali, étudiant à l'EHB (Bruxelles), dans le cadre d'un travail de fin d'études. Pour toute question relative à vos données : <a href="mailto:${PRIVACY_EMAIL}">${PRIVACY_EMAIL}</a></p>

		<h2>2. Quelles données collectons-nous ?</h2>
		<ul>
			<li><strong>Email + prénom/nom</strong> — uniquement pour créer et identifier votre compte. Pas de email marketing.</li>
			<li><strong>Localisation précise</strong> — uniquement en temps réel pour afficher les arrêts proches et calculer un itinéraire. <strong>Jamais stockée sur nos serveurs.</strong></li>
			<li><strong>Description et photo de signalements</strong> — quand vous publiez un signalement à la communauté.</li>
			<li><strong>Token push (OneSignal)</strong> — pour vous envoyer les notifications de perturbations sur vos lignes favorites.</li>
			<li><strong>Hash SHA-256 de l'IP et de l'identifiant d'appareil</strong> — pour limiter le spam (jamais stocké en clair).</li>
		</ul>

		<h2>3. Pourquoi collectons-nous ces données ?</h2>
		<ul>
			<li>Authentification et gestion du compte</li>
			<li>Affichage des perturbations en temps réel</li>
			<li>Notifications sur vos lignes/arrêts favoris</li>
			<li>Modération et anti-spam (rate limiting, détection d'abus)</li>
		</ul>

		<h2>4. Avec qui partageons-nous vos données ?</h2>
		<ul>
			<li><strong>MongoDB Atlas</strong> — hébergement de la base de données (région EU)</li>
			<li><strong>Redis Cloud</strong> — cache de session (région EU)</li>
			<li><strong>OneSignal</strong> — envoi des notifications push (région EU/US)</li>
			<li><strong>Cloudinary</strong> — hébergement des photos de signalements (région EU)</li>
			<li><strong>OpenAI / Gemini</strong> — modération automatique des signalements et assistant conversationnel. Aucune donnée personnelle directement identifiable n'est transmise.</li>
		</ul>

		<h2>5. Combien de temps conservons-nous vos données ?</h2>
		<ul>
			<li><strong>Signalements communauté</strong> — 30 jours puis suppression automatique</li>
			<li><strong>Compte utilisateur</strong> — tant que vous le souhaitez, supprimable à tout moment</li>
			<li><strong>Identifiants anti-spam</strong> — 90 jours après votre dernière activité</li>
		</ul>

		<h2>6. Vos droits (RGPD)</h2>
		<ul>
			<li><strong>Accès</strong> — exportez l'ensemble de vos données depuis Profil → Confidentialité</li>
			<li><strong>Suppression</strong> — supprimez votre compte définitivement depuis Profil → Confidentialité → Supprimer le compte</li>
			<li><strong>Rectification</strong> — modifiez vos infos depuis Profil → Infos personnelles</li>
			<li><strong>Opposition au traitement</strong> — désactivez les notifications push depuis Profil → Notifications</li>
		</ul>
		<p>Vous pouvez également exercer ces droits par email à <a href="mailto:${PRIVACY_EMAIL}">${PRIVACY_EMAIL}</a>. Nous répondons sous 30 jours.</p>

		<h2>7. Sécurité</h2>
		<p>Toutes les communications app ↔ serveur sont chiffrées en TLS. Les mots de passe sont stockés avec bcrypt (cost 12). Les tokens JWT expirent toutes les 24 h. Les photos sont servies via Cloudinary en HTTPS.</p>

		<h2>8. Modifications</h2>
		<p>Cette politique peut évoluer. Toute modification majeure vous sera notifiée dans l'application au prochain lancement.</p>

		<div class="contact">
			<strong>Contact RGPD</strong><br />
			<a href="mailto:${PRIVACY_EMAIL}">${PRIVACY_EMAIL}</a>
		</div>

		<div class="footer">
			StibAlert © ${new Date().getFullYear()} Achraf Benali · TFE EHB Bruxelles<br />
			Application indépendante non affiliée à STIB-MIVB, SNCB, De Lijn ou TEC.
		</div>
	</div>
</body>
</html>`;
	res.set("Content-Type", "text/html; charset=utf-8").status(200).send(html);
};

exports.supportHTML = (req, res) => {
	const html = `<!doctype html>
<html lang="fr">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width,initial-scale=1" />
	<title>Support — StibAlert</title>
	<style>${baseStyle}</style>
</head>
<body>
	<div class="container">
		<div class="header">
			<div class="eyebrow">StibAlert · Bruxelles</div>
			<h1>Support</h1>
		</div>

		<div class="notice">
			<strong>Application indépendante.</strong> StibAlert n'est ni produite, ni endossée, ni affiliée à STIB-MIVB, SNCB, De Lijn ou TEC.
		</div>

		<h2>Une question ?</h2>
		<p>Le développeur répond à toutes les demandes par email :</p>

		<div class="contact">
			<strong>Email support</strong><br />
			<a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a><br />
			<span style="font-size: 12.5px; color: #666;">Réponse sous 1 à 3 jours ouvrés.</span>
		</div>

		<h2>Problèmes fréquents</h2>
		<h3>Les arrêts ne s'affichent pas sur la carte</h3>
		<p>Vérifiez que la localisation est autorisée dans Réglages iOS → StibAlert → Position. Activez-la "Pendant l'utilisation".</p>

		<h3>Aucune notification de perturbation</h3>
		<p>Vérifiez que les notifications sont autorisées dans Réglages iOS → StibAlert → Notifications.</p>

		<h3>L'assistant vocal "Hey Mobi" ne répond pas</h3>
		<p>Le micro doit être autorisé (Réglages iOS → StibAlert → Micro) ainsi que la reconnaissance vocale.</p>

		<h3>Supprimer mon compte</h3>
		<p>Profil → Confidentialité → Supprimer le compte. L'opération est immédiate et définitive.</p>

		<div class="footer">
			StibAlert © ${new Date().getFullYear()} Achraf Benali · TFE EHB Bruxelles
		</div>
	</div>
</body>
</html>`;
	res.set("Content-Type", "text/html; charset=utf-8").status(200).send(html);
};
