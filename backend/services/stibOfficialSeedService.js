const crypto = require("crypto");
const Signalement = require("../models/Signalement");
const Arret = require("../models/Arret");
const Cluster = require("../models/Cluster");
const { getTravellersInformation } = require("./belgianMobility");
const { sendAlertsForNewPerturbations } = require("./perturbationAlertService");

const OFFICIAL_CLUSTER_LIFETIME_MS = 6 * 60 * 60 * 1000; // Officials stay published for 6h

async function seedOrUpdateOfficialCluster({ signalement, item }) {
	if (!signalement?.ligne || !signalement?.arretId || !signalement?.typeProbleme) {
		return null;
	}

	const now = new Date();
	const expiresAt = item?.endTime ? new Date(item.endTime) : new Date(now.getTime() + OFFICIAL_CLUSTER_LIFETIME_MS);

	let cluster = await Cluster.findOne({
		ligne: signalement.ligne,
		arretId: signalement.arretId,
		typeProbleme: signalement.typeProbleme,
		isOfficial: true,
		status: { $in: ["active", "unpublished"] },
	});

	if (!cluster) {
		const clusterIndex = await Cluster.nextIndex();
		cluster = new Cluster({
			clusterIndex,
			ligne: signalement.ligne,
			arretId: signalement.arretId,
			typeProbleme: signalement.typeProbleme,
			signalementIds: [signalement._id],
			reportCount: 1,
			aggregateTrust: 100, // Official source = max trust.
			confidence: "high",
			firstReportedAt: now,
			lastReportedAt: now,
			expiresAt,
			status: "active",
			isOfficial: true,
			officialSignalementId: signalement._id,
			latitude: signalement.latitude,
			longitude: signalement.longitude,
		});
	} else {
		// Refresh
		if (!cluster.signalementIds.some((id) => String(id) === String(signalement._id))) {
			cluster.signalementIds.push(signalement._id);
		}
		cluster.lastReportedAt = now;
		cluster.expiresAt = expiresAt;
		cluster.status = "active";
		cluster.aggregateTrust = 100;
		cluster.confidence = "high";
		cluster.latitude = signalement.latitude || cluster.latitude;
		cluster.longitude = signalement.longitude || cluster.longitude;
	}

	await cluster.save();
	return cluster;
}

async function archiveOfficialClustersFor(externalIds) {
	if (!Array.isArray(externalIds) || externalIds.length === 0) return 0;
	const matchingSignalements = await Signalement.find({
		source: "stib_officiel",
		externalId: { $in: externalIds },
	}).select("_id").lean();
	const ids = matchingSignalements.map((s) => s._id);
	if (ids.length === 0) return 0;

	const result = await Cluster.updateMany(
		{
			isOfficial: true,
			status: "active",
			signalementIds: { $in: ids },
		},
		{
			$set: { status: "archived", archivedAt: new Date() },
		}
	);
	return result.modifiedCount || 0;
}

let quotaBlockedUntil = 0;
let lastQuotaLogAt = 0;

function mapToProblemType(text = "") {
	const lower = String(text)
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase();

	if (/(interrompu|interruption|supprime|suppression|interrupted|onderbroken)/.test(lower)) {
		return "Interruption";
	}
	if (/(non desservi|arret non servi|not served|halte niet bediend)/.test(lower)) {
		return "Arrêt non desservi";
	}
	if (/(travaux|works|werken|chantier)/.test(lower)) {
		return "Travaux";
	}
	if (/(devi|deviation|diversion|omgeleid|detour)/.test(lower)) {
		return "Déviation";
	}
	if (/(retard|delay|vertraging|attente)/.test(lower)) {
		return "Retard";
	}
	if (/(accident|collision|chute)/.test(lower)) {
		return "Accident";
	}
	if (/(panne|breakdown|incident|bloque|immobilise)/.test(lower)) {
		return "Panne";
	}
	if (/(police|ordre de police|manifestation|event|evenement|evenement)/.test(lower)) {
		return "Perturbation";
	}
	return "Information STIB";
}

// Brussels city center as fallback for line-level perturbations
const BRUSSELS_CENTER = { latitude: 50.8503, longitude: 4.3517 };

// Rough GPS per line terminus — gives map pins a meaningful position
const LINE_COORDINATES = {
	"1": { latitude: 50.8617, longitude: 4.3342 },
	"2": { latitude: 50.8421, longitude: 4.3678 },
	"3": { latitude: 50.8578, longitude: 4.3212 },
	"4": { latitude: 50.8234, longitude: 4.3891 },
	"5": { latitude: 50.8345, longitude: 4.3654 },
	"6": { latitude: 50.8512, longitude: 4.3189 },
	"19": { latitude: 50.8712, longitude: 4.3534 },
	"25": { latitude: 50.8234, longitude: 4.4012 },
	"44": { latitude: 50.8645, longitude: 4.4123 },
	"55": { latitude: 50.8423, longitude: 4.3123 },
	"81": { latitude: 50.8756, longitude: 4.3645 },
};

function stableOfficialId(item) {
	if (item.id) return String(item.id);
	const signature = JSON.stringify({
		lines: item.lines || [],
		stops: item.stops || [],
		title: item.title || "",
		description: item.description || "",
		priority: item.priority || null,
	});
	return `stib-${crypto.createHash("sha1").update(signature).digest("hex").slice(0, 16)}`;
}

async function resolveOfficialStop(item) {
	const stopIds = Array.isArray(item.stops) ? item.stops.map((value) => String(value)) : [];
	if (!stopIds.length) return null;

	return Arret.findOne({
		$or: [
			{ stop_id: { $in: stopIds } },
			{ merged_stop_id: { $in: stopIds } },
			{ physicalStopIds: { $in: stopIds } },
		],
	}).lean();
}

async function buildSignalementFromItem(item) {
	const firstLine = Array.isArray(item.lines) && item.lines.length > 0
		? String(item.lines[0]).toUpperCase()
		: "STIB";

	const description = item.description || item.title || "Perturbation officielle STIB.";
	const typeProbleme = mapToProblemType(item.title || item.description || "");

	const matchedStop = await resolveOfficialStop(item);
	const coords = matchedStop
		? { latitude: matchedStop.latitude, longitude: matchedStop.longitude }
		: (LINE_COORDINATES[firstLine] || BRUSSELS_CENTER);

	return {
		source: "stib_officiel",
		authorType: "official",
		moderationStatus: "approved",
		externalId: stableOfficialId(item),
		ligne: firstLine,
		typeProbleme,
		description: String(description).slice(0, 500),
		latitude: coords.latitude,
		longitude: coords.longitude,
		validationIA: true,
		resumeIA: item.title ? String(item.title).slice(0, 200) : null,
		confiance: "haute",
		status: "active",
		arretId: matchedStop?._id,
		utilisateurId: undefined,
	};
}

function nowMs() {
	return Date.now();
}

function secondsUntilQuotaReset() {
	return Math.max(Math.ceil((quotaBlockedUntil - nowMs()) / 1000), 0);
}

function shouldSkipForQuota() {
	return quotaBlockedUntil > nowMs();
}

function setQuotaCooldown(error) {
	const retryAfterSeconds = error.retryAfter && error.retryAfter > 0
		? error.retryAfter
		: 60 * 30;
	quotaBlockedUntil = Math.max(quotaBlockedUntil, nowMs() + (retryAfterSeconds * 1000));
}

function logQuotaPauseOnce() {
	const remaining = secondsUntilQuotaReset();
	if (remaining <= 0) return;

	// Avoid repeating the same quota warning on every interval tick.
	if (nowMs() - lastQuotaLogAt < 60_000) {
		return;
	}

	lastQuotaLogAt = nowMs();
	console.warn(`[stib-seed] Pause quota active. Reprise dans ${remaining}s.`);
}

async function syncOfficialPerturbations() {
	if (shouldSkipForQuota()) {
		logQuotaPauseOnce();
		return {
			synced: 0,
			resolved: 0,
			skipped: true,
			reason: "quota_cooldown",
			retryAfterSeconds: secondsUntilQuotaReset(),
		};
	}

	let result;
	try {
		result = await getTravellersInformation({});
	} catch (error) {
		if (error.isQuotaExceeded || error.status === 429) {
			setQuotaCooldown(error);
			logQuotaPauseOnce();
			return {
				synced: 0,
				resolved: 0,
				skipped: true,
				reason: "quota_cooldown",
				error: error.message,
				retryAfterSeconds: secondsUntilQuotaReset(),
			};
		}

		console.warn("[stib-seed] Impossible de récupérer TravellersInformation:", error.message);
		return { synced: 0, resolved: 0, error: error.message };
	}

	const items = (result?.items || []).filter((item) => {
		// Keep French items only; if no language specified, keep it
		const lang = (item.language || item.raw?.language || "").toLowerCase();
		return !lang || lang === "fr" || lang === "french" || lang === "fra";
	});

	if (items.length === 0) {
		return { synced: 0, resolved: 0 };
	}

	const seenExternalIds = [];
	const newSignalements = []; // newly inserted this cycle — used for immediate push alerts
	let synced = 0;

	for (const item of items) {
		const externalId = stableOfficialId(item);
		seenExternalIds.push(externalId);
		const data = await buildSignalementFromItem(item);
		try {
			const result = await Signalement.updateOne(
				{ externalId, source: "stib_officiel" },
				{
					$set: {
						...data,
						dateSignalement: item.updatedAt ? new Date(item.updatedAt) : new Date(),
					},
					$setOnInsert: { createdAt: new Date() },
				},
				{ upsert: true }
			);
			synced += 1;

			// upsertedId is set only when a brand-new document was inserted
			if (result.upsertedId) {
				newSignalements.push({ ...data, externalId });
			}

			// Seed/refresh the official Cluster so cold-start users immediately
			// see disruptions on the map and in /api/decision, even without any
			// community signalements yet.
			try {
				const signalement = await Signalement.findOne({ externalId, source: "stib_officiel" })
					.select("_id ligne arretId typeProbleme latitude longitude")
					.lean();
				if (signalement) {
					await seedOrUpdateOfficialCluster({ signalement, item });
				}
			} catch (clusterErr) {
				console.warn(`[stib-seed] Cluster seeding failed for ${externalId}: ${clusterErr.message}`);
			}
		} catch (error) {
			console.warn(`[stib-seed] Upsert failed for ${externalId}: ${error.message}`);
		}
	}

	// Resolve official signalements that are no longer in the feed
	const { modifiedCount: resolved } = await Signalement.updateMany(
		{
			source: "stib_officiel",
			status: "active",
			externalId: { $nin: seenExternalIds },
		},
		{ $set: { status: "resolved" } }
	);

	// Archive the corresponding official clusters — STIB says the disruption is over.
	const removedFromFeed = await Signalement.find({
		source: "stib_officiel",
		status: "resolved",
		externalId: { $nin: seenExternalIds },
	}).select("externalId").lean();
	const removedIds = removedFromFeed.map((s) => s.externalId).filter(Boolean);
	const archivedClusters = removedIds.length > 0
		? await archiveOfficialClustersFor(removedIds)
		: 0;

	// Fire immediate push alerts for newly detected perturbations
	if (newSignalements.length > 0) {
		sendAlertsForNewPerturbations(newSignalements)
			.then((r) => {
				if (r.sent > 0) console.log(`[stib-seed] Push alerts sent: ${r.sent}`);
			})
			.catch((e) => console.warn("[stib-seed] Alert dispatch error:", e.message));
	}

	return { synced, resolved, newPerturbations: newSignalements.length, archivedClusters };
}

function startStibOfficialSeedLoop() {
	const enabledRaw = String(process.env.STIB_OFFICIAL_SEED_ENABLED || "").trim().toLowerCase();
	const isExplicitlyDisabled = ["0", "false", "off", "no"].includes(enabledRaw);
	if (isExplicitlyDisabled) {
		console.log("[stib-seed] loop disabled by STIB_OFFICIAL_SEED_ENABLED");
		return null;
	}

	const defaultIntervalMinutes = 10;
	const intervalMinutes = Number(
		process.env.STIB_OFFICIAL_SEED_INTERVAL_MINUTES || defaultIntervalMinutes
	);
	if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) {
		console.warn("[stib-seed] invalid interval, fallback to 10 min");
	}
	const safeIntervalMinutes = Number.isFinite(intervalMinutes) && intervalMinutes > 0
		? intervalMinutes
		: defaultIntervalMinutes;

	// Run immediately on startup, then on interval
	syncOfficialPerturbations()
		.then((r) => console.log("[stib-seed] Initial sync:", r))
		.catch((e) => console.error("[stib-seed] Initial sync error:", e.message));

	const intervalMs = safeIntervalMinutes * 60 * 1000;
	const timer = setInterval(() => {
		syncOfficialPerturbations()
			.then((r) => {
				if (r.synced > 0 || r.resolved > 0) {
					console.log("[stib-seed]", r);
				}
			})
			.catch((e) => console.error("[stib-seed]", e.message));
	}, intervalMs);

	timer.unref?.();
	console.log(`[stib-seed] loop enabled every ${safeIntervalMinutes} min`);
	return timer;
}

module.exports = { syncOfficialPerturbations, startStibOfficialSeedLoop };
