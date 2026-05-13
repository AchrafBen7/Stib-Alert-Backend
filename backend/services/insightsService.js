const Utilisateur = require("../models/Utilisateur");
const Cluster = require("../models/Cluster");
const Contribution = require("../models/Contribution");

// Estimated time loss per perturbation severity, in minutes.
// Conservative averages — better to undersell than oversell to the user.
const AVG_LOSS_PER_DISRUPTION = {
	critical: 18,
	major: 12,
	minor: 7,
	weak: 3,
};

function severityForCluster(cluster) {
	if (cluster.confidence === "high" && cluster.reportCount >= 5) return "critical";
	if (cluster.reportCount >= 4) return "major";
	if (cluster.reportCount >= 3) return "minor";
	return "weak";
}

function estimateMinutesSavedFromCluster(cluster) {
	const severity = severityForCluster(cluster);
	return AVG_LOSS_PER_DISRUPTION[severity] || 0;
}

async function computeInsights({ userId, daysBack = 30 }) {
	if (!userId) {
		return {
			period: { daysBack, since: null, until: new Date().toISOString() },
			estimatedMinutesSaved: 0,
			peopleHelped: 0,
			disruptionsAvoided: 0,
			contributionsCount: 0,
			topAffectedLine: null,
			disclaimer: "Connectez-vous pour voir vos statistiques personnelles.",
		};
	}

	const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
	const user = await Utilisateur.findById(userId)
		.select("favoriteLines routine createdAt")
		.lean();

	if (!user) {
		return null;
	}

	const favoriteLines = Array.isArray(user.favoriteLines) ? user.favoriteLines.map((l) => l.toUpperCase()) : [];
	const hasFavorites = favoriteLines.length > 0;

	// Find clusters that affected the user's favorite lines OR their routine stops.
	const clusterQuery = {
		createdAt: { $gte: since },
		status: { $in: ["active", "resolved", "archived"] },
	};

	const orFilters = [];
	if (favoriteLines.length > 0) {
		orFilters.push({ ligne: { $in: favoriteLines } });
	}
	if (user.routine?.homeStopId) {
		orFilters.push({ arretId: user.routine.homeStopId });
	}
	if (user.routine?.workStopId) {
		orFilters.push({ arretId: user.routine.workStopId });
	}

	if (orFilters.length > 0) {
		clusterQuery.$or = orFilters;
	}

	const affectedClusters = await Cluster.find(clusterQuery)
		.select("clusterIndex ligne reportCount confidence createdAt")
		.lean();

	const totalMinutesSavedRaw = affectedClusters.reduce(
		(sum, c) => sum + estimateMinutesSavedFromCluster(c),
		0
	);

	// Cap to a reasonable max — don't claim absurd numbers if the data is patchy.
	const totalMinutesSaved = Math.min(totalMinutesSavedRaw, 600);

	// Compute top affected line for narrative ("Ta ligne 56 a eu 7 perturbations")
	const linesByCount = {};
	for (const c of affectedClusters) {
		const line = String(c.ligne || "").toUpperCase();
		linesByCount[line] = (linesByCount[line] || 0) + 1;
	}
	const topAffectedLine = Object.entries(linesByCount)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 1)
		.map(([line, count]) => ({ line, disruptions: count }))[0] || null;

	// Helped community = sum of peopleHelped across user's confirmed contributions.
	const contributions = await Contribution.find({ utilisateurId: userId })
		.select("peopleHelped role helpedPublishCluster")
		.lean();

	const peopleHelped = contributions.reduce((sum, c) => sum + (c.peopleHelped || 0), 0);

	// Account age in days (for narrative — "depuis que tu utilises StibAlert")
	const accountAgeDays = Math.max(
		1,
		Math.round((Date.now() - new Date(user.createdAt).getTime()) / 86_400_000)
	);

	return {
		period: {
			daysBack,
			since: since.toISOString(),
			until: new Date().toISOString(),
		},
		hasFavorites,
		accountAgeDays,
		estimatedMinutesSaved: totalMinutesSaved,
		isMinutesSavedEstimate: true,
		peopleHelped,
		disruptionsAvoided: affectedClusters.length,
		contributionsCount: contributions.length,
		topAffectedLine,
		narrative: buildNarrative({
			daysBack,
			totalMinutesSaved,
			peopleHelped,
			disruptionsCount: affectedClusters.length,
			topLine: topAffectedLine,
			hasFavorites,
		}),
		disclaimer: "Estimation basée sur les perturbations connues sur tes lignes favorites. Suppose que tu suis nos verdicts.",
	};
}

function buildNarrative({ daysBack, totalMinutesSaved, peopleHelped, disruptionsCount, topLine, hasFavorites }) {
	if (!hasFavorites) {
		return {
			headline: "Configure tes lignes favorites",
			body: "Ajoute jusqu'à 4 lignes dans ton profil pour voir tes statistiques personnelles.",
			tone: "setup",
		};
	}

	if (disruptionsCount === 0) {
		return {
			headline: `Tes lignes ont été fluides`,
			body: `Aucune perturbation détectée sur tes favoris ces ${daysBack} derniers jours. Bon réseau ce mois-ci.`,
			tone: "neutral",
		};
	}

	const hours = Math.floor(totalMinutesSaved / 60);
	const mins = totalMinutesSaved % 60;
	const savedText = hours > 0
		? `~${hours}h${mins > 0 ? mins.toString().padStart(2, "0") : ""}`
		: `~${totalMinutesSaved} min`;

	let body = `Sur les ${daysBack} derniers jours, tu as évité ${disruptionsCount} perturbation${disruptionsCount > 1 ? "s" : ""} si tu as suivi nos verdicts.`;
	if (topLine) {
		body += ` La ligne ${topLine.line} a été la plus touchée (${topLine.disruptions} alertes).`;
	}
	if (peopleHelped > 0) {
		body += ` Tu as aussi aidé ${peopleHelped} personne${peopleHelped > 1 ? "s" : ""} avec tes signalements.`;
	}

	return {
		headline: `${savedText} économisées ce mois`,
		body,
		tone: "win",
	};
}

module.exports = {
	computeInsights,
	estimateMinutesSavedFromCluster,
};
