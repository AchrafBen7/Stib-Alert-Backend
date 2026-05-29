const AssistantNotificationLog = require("../models/AssistantNotificationLog");

// Plafonds globaux par utilisateur (hors critique). "tout" relâche les seuils.
const FREQ_CAP_HOUR = 3;
const FREQ_CAP_DAY = 8;
const FREQ_CAP_HOUR_RELAXED = 6;
const FREQ_CAP_DAY_RELAXED = 20;

// Fenêtre de dé-dup inter-types (alignée sur le plus long cooldown existant).
const DEDUP_WINDOW_MS = 4 * 60 * 60 * 1000;

// Incidents critiques — cohérent avec perturbationAlertService / clusterService.
const CRITICAL_TYPES = new Set(["Accident", "Agression", "Interruption"]);

function isCriticalType(typeProbleme) {
	return CRITICAL_TYPES.has(typeProbleme);
}

// #2 — Clé d'incident CANONIQUE : un même incident (perturbation officielle OU
// cluster communautaire) sur la même ligne/arrêt partage cette clé, peu importe
// le type de push. Permet de ne notifier qu'UNE fois.
function buildIncidentKey({ ligne, stopId, clusterIndex } = {}) {
	const target = clusterIndex != null
		? `c${clusterIndex}`
		: stopId
			? `s${stopId}`
			: "net";
	return `${String(ligne || "").toUpperCase()}:${target}`;
}

// #4 — Résout le niveau de notif d'une cible (arrêt prioritaire sur ligne).
function resolveRuleLevel(user, { ligne, stopId } = {}) {
	const rules = user?.notificationRules || [];
	if (stopId) {
		const r = rules.find((x) => x.scope === "stop" && String(x.key) === String(stopId));
		if (r) return r.level;
	}
	if (ligne) {
		const r = rules.find((x) => x.scope === "line" && String(x.key).toUpperCase() === String(ligne).toUpperCase());
		if (r) return r.level;
	}
	return null;
}

/**
 * Décision centrale d'envoi d'un push communautaire / perturbation.
 * Retourne { allow, defer, reason, incidentKey }.
 *  - allow=true  → envoyer (puis logger avec incidentKey)
 *  - defer=true  → ne pas envoyer en direct, mais agréger au digest (logDeferred)
 *  - sinon       → supprimer (drop silencieux)
 * Les critiques bypassent fréquence + débit (mais pas une règle "off" explicite).
 */
async function evaluatePush({ userId, user, ligne, stopId, clusterIndex, stage, isCritical } = {}) {
	const critical = Boolean(isCritical);
	const incidentKey = buildIncidentKey({ ligne, stopId, clusterIndex });
	const freq = user?.notificationFrequency || "essentiel";

	// 2. Règle par ligne/arrêt — un "off" explicite bloque MÊME le critique.
	const level = resolveRuleLevel(user, { ligne, stopId });
	if (level === "off") {
		return { allow: false, defer: false, reason: "rule_off", incidentKey };
	}

	// 1. Débit global (sélecteur) — critique exempté.
	if (!critical) {
		if (freq === "digest") return { allow: false, defer: true, reason: "freq_digest", incidentKey };
		if (freq === "critique") return { allow: false, defer: false, reason: "freq_critical_only", incidentKey };
		if (level === "critique") return { allow: false, defer: false, reason: "rule_critical_only", incidentKey };
	}

	// 3. Dé-dup inter-types (incidentKey + étape).
	try {
		const recent = await AssistantNotificationLog.findOne({
			userId,
			incidentKey,
			deferred: { $ne: true },
			sentAt: { $gte: new Date(Date.now() - DEDUP_WINDOW_MS) },
			...(stage ? { stage } : {}),
		}).lean();
		if (recent) return { allow: false, defer: false, reason: "duplicate_incident", incidentKey };
	} catch (_) { /* lecture log non bloquante */ }

	// 4. Plafond de fréquence global (critique exempté).
	if (!critical) {
		const now = Date.now();
		try {
			const [hourCount, dayCount] = await Promise.all([
				AssistantNotificationLog.countDocuments({ userId, deferred: { $ne: true }, sentAt: { $gte: new Date(now - 60 * 60 * 1000) } }),
				AssistantNotificationLog.countDocuments({ userId, deferred: { $ne: true }, sentAt: { $gte: new Date(now - 24 * 60 * 60 * 1000) } }),
			]);
			const hourCap = freq === "tout" ? FREQ_CAP_HOUR_RELAXED : FREQ_CAP_HOUR;
			const dayCap = freq === "tout" ? FREQ_CAP_DAY_RELAXED : FREQ_CAP_DAY;
			if (hourCount >= hourCap || dayCount >= dayCap) {
				return { allow: false, defer: true, reason: "freq_cap", incidentKey };
			}
		} catch (_) { /* count non bloquant : on laisse passer */ }
	}

	return { allow: true, defer: false, reason: "ok", incidentKey };
}

// Enregistre une suppression "deferred" pour agrégation par le digest.
async function logDeferred({ userId, type, incidentKey, title, message, stage }) {
	try {
		await AssistantNotificationLog.create({
			userId,
			type,
			contextKey: incidentKey || `${type}:deferred`,
			incidentKey: incidentKey || null,
			deferred: true,
			title,
			message,
			stage: stage || null,
			sentAt: new Date(),
		});
	} catch (_) { /* non bloquant */ }
}

module.exports = {
	evaluatePush,
	buildIncidentKey,
	resolveRuleLevel,
	isCriticalType,
	logDeferred,
	FREQ_CAP_HOUR,
	FREQ_CAP_DAY,
	DEDUP_WINDOW_MS,
};
