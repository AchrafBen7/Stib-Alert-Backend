const Utilisateur = require("../models/Utilisateur");
const { getTransportOverview, recommendRoute } = require("./transportService");
const sendMail = require("../config/Mail");
const { sendManagedCommutePush } = require("./assistantPushPolicyService");

function resolveVisualState({ severity, type }) {
	if (type === "guide") return "guiding";
	if (severity === "critical" || severity === "major") return "alert";
	if (severity === "minor") return "watching";
	return "idle";
}

function resolvePriority(severity) {
	switch (severity) {
	case "critical":
		return "high";
	case "major":
		return "elevated";
	default:
		return "normal";
	}
}

function resolveMessageType(severity, fallback = "status") {
	switch (severity) {
	case "critical":
	case "major":
		return "warning";
	case "minor":
		return "confidence_note";
	default:
		return fallback;
	}
}

function parseClock(clock) {
	if (!clock || !/^\d{2}:\d{2}$/.test(String(clock))) return null;
	const [hours, minutes] = String(clock).split(":").map(Number);
	if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;
	return hours * 60 + minutes;
}

function minutesUntilClock(clock, now = new Date()) {
	const target = parseClock(clock);
	if (target === null) return null;
	return target - (now.getHours() * 60 + now.getMinutes());
}

function resolveCommuteTiming(minutesUntilDeparture, severity, hasAlternative) {
	if (minutesUntilDeparture === null) {
		return {
			stage: "unscheduled",
			decision: hasAlternative && (severity === "major" || severity === "critical") ? "detour" : "watch",
		};
	}

	if (severity === "critical") {
		return { stage: "critical_window", decision: hasAlternative ? "detour" : "wait" };
	}

	if (severity === "major" && minutesUntilDeparture <= 20) {
		return { stage: "fragile_window", decision: hasAlternative ? "detour" : "leave_now" };
	}

	if (minutesUntilDeparture > 35) {
		return { stage: "early_watch", decision: "wait" };
	}

	if (minutesUntilDeparture > 12) {
		return { stage: "prepare", decision: "prepare" };
	}

	if (minutesUntilDeparture >= -5) {
		return { stage: "departure_window", decision: "leave_now" };
	}

	return { stage: "late_window", decision: hasAlternative ? "detour" : "leave_now" };
}

function buildHomeCopy(overview) {
	const hasIncidents = overview.activeIncidents.length > 0;
	const nextDeparture = overview.nextDepartures[0];

	switch (overview.severity) {
	case "critical":
		return {
			type: "alert",
			title: "Je déconseille de partir maintenant",
			message: hasIncidents
				? "Plusieurs perturbations fortes sont actives autour de vous. Je recommande d’attendre ou de vérifier une alternative."
				: "Le réseau autour de vous est trop instable pour recommander un départ immédiat.",
			actions: [
				{ id: "view_reports", label: "Voir les signalements" },
				{ id: "open_search", label: "Chercher une alternative" },
			],
		};
	case "major":
		return {
			type: "warning",
			title: "Le réseau reste praticable, mais fragile",
			message: nextDeparture
				? `Le prochain passage utile semble être la ligne ${nextDeparture.line} dans ${nextDeparture.minutes} min. Je recommande de rester prudent sur votre corridor.`
				: "Des perturbations fortes sont actives. Je préfère vérifier une alternative avant de vous faire partir.",
			actions: [
				{ id: "open_search", label: "Voir une alternative" },
				{ id: "view_reports", label: "Comprendre le risque" },
			],
		};
	case "minor":
		return {
			type: "confidence_note",
			title: "Vous pouvez probablement partir",
			message: nextDeparture
				? `Le réseau semble exploitable. Prochain passage repéré : ligne ${nextDeparture.line} dans ${nextDeparture.minutes} min.`
				: "Je ne vois pas d’incident majeur, mais les données restent légèrement instables.",
			actions: [
				{ id: "view_map", label: "Voir la carte" },
			],
		};
	default:
		return {
			type: "status",
			title: "Vous pouvez partir maintenant",
			message: nextDeparture
				? `Aucun incident majeur n’affecte votre zone. Prochain passage utile : ligne ${nextDeparture.line} dans ${nextDeparture.minutes} min.`
				: "Aucun incident majeur détecté autour de vous pour le moment.",
			actions: [
				{ id: "view_map", label: "Voir la carte" },
			],
		};
	}
}

function buildRouteCopy(recommendation) {
	if (recommendation.fallback) {
		return {
			type: "confidence_note",
			title: "Je garde une lecture prudente",
			message: recommendation.fallback.message,
			actions: [
				{ id: "view_reports", label: "Voir les perturbations" },
			],
		};
	}

	const best = recommendation.recommendedAlternatives[0];
	if (!best) {
		return {
			type: "confidence_note",
			title: "Je n’ai pas mieux pour l’instant",
			message: "Je n’ai pas trouvé d’alternative exploitable avec un bon niveau de confiance.",
			actions: [],
		};
	}

	const isReliable = best.type === "most_reliable" || best.type === "best_overall";
	return {
		type: isReliable ? "recommendation" : "comparison",
		title: isReliable ? "Je recommande cette option" : "Je préfère cette alternative",
		message: best.explanation || `Cette option reste la plus pertinente pour le moment. Temps estimé ${best.totalDurationMinutes} min.`,
		actions: [
			{ id: "view_route", label: "Voir le trajet" },
			{ id: "compare_routes", label: "Comparer" },
		],
	};
}

function buildCommandCopy({ message, screen, context, memory = {} }) {
	const normalized = String(message || "")
		.toLowerCase()
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "");

	const favoriteCount = context.favorites.count;
	const primaryStopName = context.habits.primaryStopName;
	const incidents = context.transport.activeIncidentsCount;
	const nextDeparture = context.transport.nextDepartures[0];
	const severity = context.transport.severity;
	const confidence = context.transport.confidence;
	const lastAssistantTitle = memory.lastAssistantTitle;
	const recentMessages = memory.recentMessages || [];

	if (!normalized.trim()) {
		return {
			type: "status",
			severity,
			confidence,
			title: "Je suis prêt",
			message: "Dis-moi ce que tu veux comprendre : partir maintenant, tes favoris, une alternative, ou un signalement.",
			actions: [
				{ id: "ask_leave_now", label: "Puis-je partir ?" },
				{ id: "open_favorites", label: "Mes favoris" },
				{ id: "open_report", label: "Signaler" },
			],
		};
	}

	if (normalized.includes("partir") || normalized.includes("maintenant") || normalized.includes("peux-je") || normalized.includes("peux je")) {
		if (severity === "critical") {
			return {
				type: "warning",
				severity,
				confidence,
				title: "Je déconseille de partir maintenant",
				message: incidents > 0
					? `Je vois ${incidents} perturbation${incidents > 1 ? "s" : ""} active${incidents > 1 ? "s" : ""} sur ton corridor. Attends ou vérifie une alternative.`
					: "Le réseau est trop instable pour recommander un départ immédiat.",
				actions: [
					{ id: "open_home", label: "Voir la carte" },
					{ id: "open_lines", label: "Voir les lignes" },
				],
			};
		}

		return {
			type: "status",
			severity,
			confidence,
			title: "Tu peux probablement partir",
			message: nextDeparture
				? `Le prochain passage utile semble être la ligne ${nextDeparture.line} dans ${nextDeparture.minutes} min.`
				: "Je ne vois pas d’incident majeur autour de toi pour le moment.",
			actions: [
				{ id: "open_home", label: "Voir la carte" },
			],
		};
	}

	if (normalized.includes("favori")) {
		return {
			type: "commute_brief",
			severity: favoriteCount > 0 ? severity : "minor",
			confidence: favoriteCount > 0 ? confidence : 0.76,
			title: favoriteCount > 0 ? "Je surveille tes favoris" : "Tu n’as pas encore de favoris utiles",
			message: favoriteCount > 0
				? primaryStopName
					? `Je garde ${favoriteCount} arrêt${favoriteCount > 1 ? "s" : ""} en veille. ${primaryStopName} reste ton point d’ancrage principal.`
					: `Je garde ${favoriteCount} arrêt${favoriteCount > 1 ? "s" : ""} en veille pour toi.`
				: "Ajoute quelques arrêts ou lignes clés. Mes recommandations seront plus pertinentes.",
			actions: [
				{ id: "open_favorites", label: "Voir mes favoris" },
			],
		};
	}

	if (normalized.includes("alerte") || normalized.includes("pourquoi") || normalized.includes("incident") || normalized.includes("probleme")) {
		return {
			type: incidents > 0 ? "alert" : "confidence_note",
			severity,
			confidence,
			title: incidents > 0 ? "Voici ce que je surveille" : "Je ne vois rien de majeur",
			message: incidents > 0
				? `Je vois ${incidents} signalement${incidents > 1 ? "s" : ""} ou incident${incidents > 1 ? "s" : ""} actif${incidents > 1 ? "s" : ""}. La stabilité du réseau reste ${severity === "major" || severity === "critical" ? "fragile" : "moyenne"}.`
				: "Je ne vois pas d’incident majeur confirmé autour de toi pour l’instant.",
			actions: [
				{ id: "explain_risk", label: "Explique le risque" },
				{ id: "open_lines", label: "Voir les lignes" },
				{ id: "open_home", label: "Voir la carte" },
			],
		};
	}

	if (normalized.includes("explique") || normalized.includes("detail") || normalized.includes("pourquoi encore")) {
		return {
			type: "guide",
			severity,
			confidence: Math.max(confidence, 0.82),
			title: lastAssistantTitle ? `Je détaille ${lastAssistantTitle.toLowerCase()}` : "Je détaille mon raisonnement",
			message: incidents > 0
				? `Je combine les incidents actifs, les prochains passages et la stabilité de tes favoris. J’évite de te recommander un trajet rapide si son corridor reste fragile.`
				: `Je privilégie la fiabilité réelle avant la vitesse. Si un passage semble stable et sans incident majeur, je le mets devant le reste.`,
			actions: [
				{ id: "guide_me", label: "Guide-moi" },
				{ id: "request_alternative", label: "Trouve mieux" },
			],
		};
	}

	if (normalized.includes("trajet") || normalized.includes("route") || normalized.includes("alternative") || normalized.includes("aller")) {
		return {
			type: "recommendation",
			severity,
			confidence,
			title: "Je peux comparer les options",
			message: screen === "home"
				? "Indique-moi ta destination. Je te proposerai l’option STIB la plus fiable, pas seulement la plus rapide."
				: "Je peux t’aider à arbitrer entre vitesse, fiabilité, marche et correspondances.",
			actions: [
				{ id: "request_alternative", label: "Comparer des alternatives" },
				{ id: "guide_me", label: "Guide-moi" },
			],
		};
	}

	if (normalized.includes("signaler") || normalized.includes("report")) {
		return {
			type: "report_assist",
			severity: "minor",
			confidence: 0.84,
			title: "Je peux t’aider à signaler proprement",
			message: "Choisis l’arrêt exact, puis la ligne concernée. Garde la description courte et factuelle.",
			actions: [
				{ id: "open_report", label: "Ouvrir le signalement" },
			],
		};
	}

	if (normalized.includes("profil") || normalized.includes("compte") || normalized.includes("notification")) {
		return {
			type: "status",
			severity: "normal",
			confidence: 0.86,
			title: "Tes réglages pilotent mes recommandations",
			message: context.profile?.notificationsEnabled
				? "Tes notifications sont actives. Je peux te prévenir quand tes favoris deviennent instables."
				: "Active les notifications si tu veux que je te prévienne avant qu’un trajet se dégrade.",
			actions: [
				{ id: "open_profile", label: "Voir le profil" },
			],
		};
	}

	if (normalized.includes("routine") || normalized.includes("quotidien") || normalized.includes("travail") || normalized.includes("ecole")) {
		return {
			type: "commute_brief",
			severity,
			confidence: Math.max(confidence, 0.82),
			title: "Je peux suivre ton trajet quotidien",
			message: favoriteCount > 0
				? `Je peux surveiller tes arrêts favoris et détecter quand ton corridor habituel devient plus fragile que d’habitude.`
				: "Ajoute d’abord des favoris utiles. Je pourrai ensuite suivre ton trajet quotidien.",
			actions: [
				{ id: "open_commute_brief", label: "Voir mon trajet quotidien" },
				{ id: "open_favorites", label: "Voir mes favoris" },
			],
		};
	}

	if (normalized.includes("encore") && recentMessages.length > 0) {
		return {
			type: "status",
			severity,
			confidence,
			title: "Je garde le fil de cette session",
			message: `Je me base encore sur ce que nous venons de voir : ${recentMessages[recentMessages.length - 1]}.`,
			actions: [
				{ id: "explain_risk", label: "Explique encore" },
			],
		};
	}

	return {
		type: "status",
		severity,
		confidence,
		title: "Je garde la lecture la plus utile",
		message: "Je peux t’aider à partir maintenant, surveiller tes favoris, comprendre une alerte, ou guider un signalement.",
		actions: [
			{ id: "ask_leave_now", label: "Puis-je partir ?" },
			{ id: "open_favorites", label: "Mes favoris" },
			{ id: "open_report", label: "Signaler" },
		],
	};
}

function envelope(context, type, severity, confidence, payload) {
	return {
		assistant: {
			name: "Stibi",
			visualState: resolveVisualState({ severity, type }),
		},
		context,
		type,
		priority: resolvePriority(severity),
		severity,
		confidence,
		...payload,
	};
}

async function buildAssistantContext({ userId = null, lat, lng } = {}) {
	const [overview, user] = await Promise.all([
		getTransportOverview({ lat, lng }),
		userId
			? Utilisateur.findById(userId)
				.select("nom langue notifications favoris favoriteLines routine oneSignalPlayerId")
				.populate("favoris", "nom lignesDesservies stop_id")
				.populate("routine.homeStopId", "nom lignesDesservies stop_id")
				.populate("routine.workStopId", "nom lignesDesservies stop_id")
				.lean()
			: null,
	]);

	const favoriteStops = (user?.favoris || []).slice(0, 4).map((stop) => ({
		id: stop._id,
		name: stop.nom,
		lines: stop.lignesDesservies || [],
		stopId: stop.stop_id || null,
	}));

	const routine = user?.routine || null;
	const homeStop = routine?.homeStopId || null;
	const workStop = routine?.workStopId || null;

	let commutePattern = "explorer";
	if (homeStop || workStop) commutePattern = "configured_routine";
	else if (favoriteStops.length === 1) commutePattern = "single_anchor";
	else if (favoriteStops.length >= 2) commutePattern = "routine_watcher";
	else if (favoriteStops.length >= 4) commutePattern = "network_watcher";

	return {
		profile: user ? {
			name: user.nom,
			language: user.langue,
			notificationsEnabled: user.notifications,
			oneSignalPlayerId: user.oneSignalPlayerId || null,
		} : null,
		favorites: {
			count: favoriteStops.length,
			stops: favoriteStops,
			lines: user?.favoriteLines || [],
		},
		habits: {
			commutePattern,
			hasFavorites: favoriteStops.length > 0,
			primaryStopName: homeStop?.nom || favoriteStops[0]?.name || null,
			departureTime: routine?.departureTime || null,
			home: homeStop ? {
				id: String(homeStop._id || homeStop.id),
				name: homeStop.nom,
				stopId: homeStop.stop_id || null,
				label: routine?.homeLabel || "Domicile",
			} : null,
			work: workStop ? {
				id: String(workStop._id || workStop.id),
				name: workStop.nom,
				stopId: workStop.stop_id || null,
				label: routine?.workLabel || "Travail",
			} : null,
		},
		transport: {
			severity: overview.severity,
			confidence: overview.confidence,
			realtimeStatus: overview.realtimeStatus,
			nextDepartures: overview.nextDepartures.slice(0, 4),
			activeIncidentsCount: overview.activeIncidents.length,
		},
	};
}

async function getHomeBrief({ userId = null, lat, lng } = {}) {
	const overview = await getTransportOverview({ lat, lng });
	const context = await buildAssistantContext({ userId, lat, lng });
	const copy = buildHomeCopy(overview);
	return envelope("home", copy.type, overview.severity, overview.confidence, {
		title: copy.title,
		message: copy.message,
		shortMessage: copy.title,
		actions: copy.actions,
		source: "transport_overview",
		assistantContext: context,
		supporting: {
			realtimeStatus: overview.realtimeStatus,
			nextDepartures: overview.nextDepartures.slice(0, 3),
			activeIncidentsCount: overview.activeIncidents.length,
		},
	});
}

async function getRouteBrief({ userId = null, depart, destination, lignesBloquees = [] }) {
	const recommendation = await recommendRoute({ depart, destination, lignesBloquees });
	const context = await buildAssistantContext({ userId });
	const copy = buildRouteCopy(recommendation);
	return envelope("route", copy.type, recommendation.severity, recommendation.confidence, {
		title: copy.title,
		message: copy.message,
		shortMessage: copy.title,
		actions: copy.actions,
		source: "transport_recommendation",
		assistantContext: context,
		supporting: {
			realtimeStatus: recommendation.realtimeStatus,
			nextDepartures: recommendation.nextDepartures.slice(0, 3),
			activeIncidentsCount: recommendation.activeIncidents.length,
			recommendedAlternatives: recommendation.recommendedAlternatives.slice(0, 3),
		},
	});
}

async function getReportHelp({ userId = null, step, stopName, line, problemType, details, lat, lng }) {
	const context = await buildAssistantContext({ userId, lat, lng });

	let type = "report_assist";
	let title = "Je t’aide à signaler proprement";
	let message = "Choisis l’option qui décrit le mieux ce que tu observes.";
	let severity = "minor";
	let confidence = 0.72;

	switch (step) {
	case "stop":
		title = "Commence par l’arrêt le plus proche";
		message = context.habits.primaryStopName
			? `Si le problème concerne ${context.habits.primaryStopName}, sélectionne-le directement. Sinon, choisis l’arrêt le plus proche de toi.`
			: "Choisis l’arrêt le plus proche du problème. Cela améliore la fiabilité du signalement.";
		break;
	case "line":
		title = stopName ? `${stopName} sélectionné` : "Choisis la ligne concernée";
		message = line
			? `Je garde la ligne ${line} comme ligne principale du signalement.`
			: "Sélectionne la ligne qui semble vraiment touchée. Évite de signaler plusieurs lignes si une seule est concernée.";
		break;
	case "problemType":
		title = "Qualifie le problème avec précision";
		if (details && /attente|retard|minutes?/i.test(details)) {
			message = "Ce que tu décris ressemble à un retard. Vérifie si le véhicule est simplement en attente ou réellement bloqué.";
			confidence = 0.82;
		} else if (problemType) {
			message = `Je retiens ${problemType} comme catégorie principale. Garde une description courte et factuelle.`;
			confidence = 0.84;
		} else {
			message = "Choisis le type le plus probable. Si tu hésites, préfère la catégorie la plus observable.";
		}
		break;
	case "details":
		title = "Ajoute juste le détail utile";
		message = "Décris ce qui bloque vraiment : retard constaté, véhicule immobilisé, incivilité, saleté ou intervention visible.";
		break;
	case "confirmation":
		type = "confirmation_request";
		title = "Je vais envoyer ce signalement";
		message = stopName && line
			? `Je vais enregistrer un signalement pour ${stopName}, ligne ${line}. Vérifie que la catégorie et la description sont cohérentes.`
			: "Vérifie le résumé avant l’envoi. Un bon signalement doit être court, localisé et crédible.";
		confidence = 0.86;
		break;
	default:
		break;
	}

	return envelope("report", type, severity, confidence, {
		title,
		message,
		shortMessage: title,
		actions: [
			{ id: "continue_report", label: "Continuer" },
			...(step === "confirmation" ? [{ id: "confirm_report_details", label: "Vérifier le résumé" }] : []),
		],
		source: "report_assist",
		assistantContext: context,
		supporting: {
			realtimeStatus: context.transport.realtimeStatus,
			nextDepartures: context.transport.nextDepartures,
			activeIncidentsCount: context.transport.activeIncidentsCount,
		},
	});
}

async function getCommuteBrief({ userId = null, preferredStopId = null, lat, lng } = {}) {
	const context = await buildAssistantContext({ userId, lat, lng });
	const nextDeparture = context.transport.nextDepartures[0];
	const favoriteCount = context.favorites.count;
	const home = context.habits.home;
	const work = context.habits.work;
	const departureTime = context.habits.departureTime;
	const primaryStop = preferredStopId
		? context.favorites.stops.find((stop) => stop.stopId === preferredStopId || stop.id === preferredStopId)?.name || context.habits.primaryStopName
		: (home?.name || context.habits.primaryStopName);
	const hasConfiguredRoute = Boolean(home?.name && work?.name);

	const recommendation = hasConfiguredRoute
		? await recommendRoute({
			depart: home.name,
			destination: work.name,
		})
		: null;
	const bestAlternative = recommendation?.recommendedAlternatives?.[0] || null;
	const minutesUntilDeparture = minutesUntilClock(departureTime);
	const timing = resolveCommuteTiming(
		minutesUntilDeparture,
		recommendation?.severity || context.transport.severity,
		Boolean(bestAlternative)
	);

	if (favoriteCount === 0) {
		return envelope("commute", "confidence_note", "minor", 0.74, {
			title: "Je n’ai pas encore de trajet quotidien fiable",
			message: "Ajoute quelques arrêts ou lignes favoris. Je pourrai ensuite surveiller ton corridor habituel.",
			shortMessage: "Ajoute des favoris utiles",
			actions: [
				{ id: "open_favorites", label: "Configurer mes favoris" },
			],
			source: "assistant_commute",
			assistantContext: context,
			supporting: {
				realtimeStatus: context.transport.realtimeStatus,
				nextDepartures: context.transport.nextDepartures,
				activeIncidentsCount: context.transport.activeIncidentsCount,
			},
		});
	}

	const effectiveSeverity = recommendation?.severity || context.transport.severity;
	const effectiveConfidence = recommendation?.confidence || context.transport.confidence;

	let title = "Ton trajet quotidien reste exploitable";
	let message = `${home?.label || "Ton arrêt principal"}${primaryStop ? ` (${primaryStop})` : ""} reste surveillé.`;

	if (timing.decision === "detour" && bestAlternative) {
		title = "Détour conseillé ce matin";
		message = `${bestAlternative.label} est plus sûr pour ${work?.label || "ton trajet quotidien"}. ${bestAlternative.explanation}`;
	} else if (timing.decision === "wait" && typeof minutesUntilDeparture === "number" && minutesUntilDeparture > 0) {
		title = "Attends encore un peu";
		message = `Ton départ idéal est dans ${minutesUntilDeparture} min${departureTime ? `, autour de ${departureTime}` : ""}. Je continue de surveiller le corridor${bestAlternative ? " et je garde une alternative prête" : ""}.`;
	} else if (timing.decision === "prepare" && typeof minutesUntilDeparture === "number") {
		title = "Prépare ton départ";
		message = bestAlternative
			? `Ton créneau approche dans ${minutesUntilDeparture} min. ${bestAlternative.label} reste l’option la plus fiable pour l’instant.`
			: `Ton départ quotidien approche dans ${minutesUntilDeparture} min${nextDeparture ? `. Prochain passage utile : ligne ${nextDeparture.line} dans ${nextDeparture.minutes} min.` : "."}`;
	} else if (timing.decision === "leave_now") {
		title = effectiveSeverity === "major" || effectiveSeverity === "critical"
			? "Pars maintenant, mais reste prudent"
			: "Pars maintenant";
		message = bestAlternative
			? `${bestAlternative.label} reste ton meilleur compromis maintenant. ${bestAlternative.explanation}`
			: nextDeparture
				? `${home?.label || "Ton arrêt principal"}${primaryStop ? ` (${primaryStop})` : ""} reste ton meilleur point d’appui${work?.name ? ` vers ${work.label || "Travail"} (${work.name})` : ""}. Prochain passage utile : ligne ${nextDeparture.line} dans ${nextDeparture.minutes} min.`
				: `${home?.label || "Ton arrêt principal"}${primaryStop ? ` (${primaryStop})` : ""} reste exploitable.`;
	} else if (effectiveSeverity === "critical") {
		title = "Ton trajet quotidien est fragile";
		message = `${home?.label || "Ton arrêt principal"}${primaryStop ? ` (${primaryStop})` : ""} est touché par une perturbation forte. Je recommande de vérifier une alternative avant de partir.`;
	}

	return envelope("commute", "commute_brief", effectiveSeverity, effectiveConfidence, {
		title,
		message,
		shortMessage: title,
		actions: [
			{ id: "check_primary_stop", label: "Vérifier mon arrêt principal" },
			{ id: "request_alternative", label: timing.decision === "detour" ? "Voir le détour" : "Chercher une alternative" },
			{ id: "guide_me", label: "Guide-moi" },
			{ id: "push_commute_brief", label: "Recevoir ce brief en push" },
			{ id: "email_commute_brief", label: "Recevoir ce brief par email" },
			{ id: "open_favorites", label: "Voir mes favoris" },
		],
		source: "assistant_commute",
		assistantContext: context,
		supporting: {
			realtimeStatus: recommendation?.realtimeStatus || context.transport.realtimeStatus,
			nextDepartures: recommendation?.nextDepartures || context.transport.nextDepartures,
			activeIncidentsCount: recommendation?.activeIncidents?.length ?? context.transport.activeIncidentsCount,
			recommendedAlternatives: recommendation?.recommendedAlternatives?.slice(0, 3) || null,
			commuteDecision: timing.decision,
			briefingStage: timing.stage,
			minutesUntilDeparture,
			departureTime,
		},
	});
}

async function sendCommuteEmail({ userId = null, preferredStopId = null, lat, lng } = {}) {
	if (!userId) {
		const error = new Error("Authentification requise");
		error.status = 401;
		throw error;
	}

	const user = await Utilisateur.findById(userId).select("email nom");
	if (!user?.email) {
		const error = new Error("Email utilisateur introuvable");
		error.status = 400;
		throw error;
	}

	const brief = await getCommuteBrief({ userId, preferredStopId, lat, lng });
	const title = brief.title;
	const message = brief.message;
	const alternatives = brief.supporting?.recommendedAlternatives || [];
	const alternativesHtml = alternatives.length
		? `
			<h3 style="font-size:16px;margin:24px 0 10px;">Alternatives utiles</h3>
			<ul style="padding-left:18px;color:#444;line-height:1.6;">
				${alternatives.slice(0, 3).map((item) => `<li><strong>${item.label}</strong> — ${item.explanation}</li>`).join("")}
			</ul>
		`
		: "";

	const html = `
		<!DOCTYPE html>
		<html lang="fr">
		<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
		<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f4f6fb;padding:24px;color:#121826;">
			<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 8px 28px rgba(0,0,0,0.08);">
				<div style="background:#0B111E;padding:28px 28px 22px;">
					<p style="margin:0 0 10px;color:#9fc0ff;font-size:12px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;">Stibi • Commute Brief</p>
					<h1 style="margin:0;color:#ffffff;font-size:28px;line-height:1.15;">${title}</h1>
				</div>
				<div style="padding:28px;">
					<p style="margin:0 0 18px;font-size:16px;line-height:1.65;color:#243041;">${message}</p>
					${alternativesHtml}
					<div style="margin-top:28px;padding:18px;border-radius:14px;background:#eef4ff;color:#243041;font-size:14px;line-height:1.6;">
						Stibi surveille votre corridor STIB en temps réel et ajuste ce brief selon la fiabilité du trajet, les incidents actifs et les prochains passages.
					</div>
				</div>
			</div>
		</body>
		</html>
	`;

	await sendMail(user.email, `Stibi — ${title}`, html, message);

	return {
		message: `Brief commute envoyé à ${user.email}`,
		email: user.email,
		title,
	};
}

async function sendCommutePush({ userId = null, preferredStopId = null, lat, lng } = {}) {
	if (!userId) {
		const error = new Error("Authentification requise");
		error.status = 401;
		throw error;
	}

	const user = await Utilisateur.findById(userId).select("nom email");
	if (!user) {
		const error = new Error("Utilisateur introuvable");
		error.status = 404;
		throw error;
	}

	const brief = await getCommuteBrief({ userId, preferredStopId, lat, lng });
	const delivery = await sendManagedCommutePush({
		userId,
		brief,
		preferredStopId,
	});

	return {
		message: delivery.sent ? "Brief commute envoyé en push." : "Push commute ignoré par la politique d’envoi.",
		title: brief.title,
		delivery,
	};
}

async function getCommandReply({ userId = null, message, screen = "home", lat, lng, memory = {} }) {
	const context = await buildAssistantContext({ userId, lat, lng });
	const copy = buildCommandCopy({ message, screen, context, memory });

	return envelope(screen, copy.type, copy.severity, copy.confidence, {
		title: copy.title,
		message: copy.message,
		shortMessage: copy.title,
		actions: copy.actions,
		source: "assistant_command",
		assistantContext: context,
		supporting: {
			realtimeStatus: context.transport.realtimeStatus,
			nextDepartures: context.transport.nextDepartures,
			activeIncidentsCount: context.transport.activeIncidentsCount,
		},
	});
}

module.exports = {
	buildAssistantContext,
	getCommuteBrief,
	getCommandReply,
	getHomeBrief,
	getReportHelp,
	getRouteBrief,
	sendCommuteEmail,
	sendCommutePush,
};
