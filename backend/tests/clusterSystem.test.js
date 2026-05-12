const mongoose = require("mongoose");

const Signalement = require("../models/Signalement");
const Cluster = require("../models/Cluster");
const Arret = require("../models/Arret");
const DeviceLimit = require("../models/DeviceLimit");
const ModerationQueueItem = require("../models/ModerationQueueItem");

const { scoreSpam, similarity } = require("../services/spamDetectorService");
const { calculateTrust } = require("../services/trustScorerService");
const { checkLimit, recordReport, incrementSpamFlag } = require("../services/communityRateLimiterService");
const {
	assignSignalementToCluster,
	confirmStillBlocked,
	confirmResolved,
	runClusteringSweep,
	getActiveClusters,
} = require("../services/clusterService");
const { enqueueFlag, applyAction, listQueue } = require("../services/moderationService");

const { connect, disconnect, clearAll } = require("./mongoSetup");

beforeAll(connect);
afterAll(disconnect);
beforeEach(clearAll);

async function makeArret({ nom = "Test Stop", ligne = "56", latitude = 50.85, longitude = 4.35 } = {}) {
	return Arret.create({
		nom,
		latitude,
		longitude,
		lignesDesservies: [ligne],
	});
}

async function makeSignalement({
	arret,
	ligne = "56",
	typeProbleme = "Retard",
	description = "Tram retard 5 min",
	reporterDeviceHash = null,
	utilisateurId = null,
	trust = 50,
}) {
	return Signalement.create({
		arretId: arret._id,
		ligne,
		typeProbleme,
		description,
		reporterDeviceHash,
		utilisateurId,
		trust,
		authorType: utilisateurId ? "authenticated" : "anonymous",
		moderationStatus: "approved",
		status: "active",
		latitude: arret.latitude,
		longitude: arret.longitude,
		expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
	});
}

describe("Spam Detection", () => {
	test("scores empty description as suspicious", async () => {
		const result = await scoreSpam({ description: "", ligne: "56" });
		expect(result.score).toBeGreaterThan(0);
		expect(result.reasons).toContain("empty_description");
	});

	test("flags description with URLs", async () => {
		const result = await scoreSpam({
			description: "Click http://spam.com now",
			ligne: "56",
		});
		expect(result.score).toBeGreaterThan(50);
		expect(result.reasons).toContain("url_detected");
		expect(["flag", "reject", "ban"]).toContain(result.recommendation);
	});

	test("flags spam keywords", async () => {
		const result = await scoreSpam({
			description: "casino crypto bitcoin offer now",
			ligne: "56",
		});
		expect(result.score).toBeGreaterThan(40);
		expect(result.reasons.some((r) => r.startsWith("spam_keywords"))).toBe(true);
	});

	test("approves legitimate report", async () => {
		const result = await scoreSpam({
			description: "Le tram 56 est en retard de 10 minutes ce matin",
			ligne: "56",
		});
		expect(result.score).toBeLessThan(70);
		expect(result.recommendation).toBe("approve");
	});

	test("similarity detects duplicates", () => {
		expect(similarity("Tram en retard de 10 min", "Tram en retard de 10 min")).toBe(1);
		expect(similarity("Tram en retard de 10 min", "Le tram est en retard de 10 minutes")).toBeGreaterThan(0.5);
		expect(similarity("Tram retard", "Bus en panne")).toBeLessThan(0.5);
	});

	test("detects geographic outliers", async () => {
		const result = await scoreSpam({
			description: "Tram en retard",
			ligne: "56",
			latitude: 50.85,
			longitude: 4.35,
			expectedLatitude: 50.90,
			expectedLongitude: 4.40,
		});
		expect(result.reasons.some((r) => r.startsWith("geographic"))).toBe(true);
		expect(result.score).toBeGreaterThan(20);
	});
});

describe("Trust Scoring", () => {
	test("guest gets baseline 50 trust", async () => {
		const result = await calculateTrust({
			authorType: "anonymous",
			utilisateurId: null,
		});
		expect(result.score).toBeGreaterThanOrEqual(40);
		expect(result.score).toBeLessThanOrEqual(50);
		expect(result.breakdown.bonuses).not.toContain("logged_in");
	});

	test("authenticated user gets higher trust", async () => {
		const userId = new mongoose.Types.ObjectId();
		const result = await calculateTrust({
			authorType: "authenticated",
			utilisateurId: userId,
			user: {
				createdAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
				emailVerified: true,
			},
		});
		expect(result.score).toBeGreaterThanOrEqual(75);
		expect(result.breakdown.bonuses).toContain("logged_in");
		expect(result.breakdown.bonuses).toContain("account_age_30d");
	});

	test("official source gets max trust", async () => {
		const result = await calculateTrust({
			source: "stib_officiel",
			authorType: "official",
		});
		expect(result.score).toBe(100);
	});
});

describe("Rate Limiting", () => {
	beforeEach(async () => {
		process.env.NODE_ENV = "production";
	});

	afterEach(async () => {
		process.env.NODE_ENV = "test";
		await DeviceLimit.deleteMany({});
	});

	test("allows first report from new device", async () => {
		const result = await checkLimit({
			deviceHash: "device-a",
			stopId: "stop-1",
			lineId: "56",
		});
		expect(result.allowed).toBe(true);
	});

	test("blocks after 5 reports in 1 hour", async () => {
		for (let i = 0; i < 5; i++) {
			await recordReport({
				deviceHash: "device-b",
				stopId: `stop-${i}`,
				lineId: "56",
			});
		}
		const result = await checkLimit({
			deviceHash: "device-b",
			stopId: "stop-6",
			lineId: "56",
		});
		expect(result.allowed).toBe(false);
		expect(result.reason).toBe("rate_limit_hour");
	});

	test("bans device after 10 spam flags", async () => {
		for (let i = 0; i < 10; i++) {
			await incrementSpamFlag("device-c", { reason: "test_spam" });
		}
		const result = await checkLimit({
			deviceHash: "device-c",
			stopId: "stop-1",
			lineId: "56",
		});
		expect(result.allowed).toBe(false);
		expect(result.reason).toBe("device_banned");
		expect(result.retryAfterSeconds).toBeGreaterThan(0);
	});

	test("blocks same stop reported twice in 1 hour", async () => {
		await recordReport({ deviceHash: "device-d", stopId: "stop-x", lineId: "56" });
		await recordReport({ deviceHash: "device-d", stopId: "stop-x", lineId: "56" });
		const result = await checkLimit({
			deviceHash: "device-d",
			stopId: "stop-x",
			lineId: "56",
		});
		expect(result.allowed).toBe(false);
		expect(result.reason).toBe("rate_limit_stop");
	});

	test("blocks rapid-fire (< 15s)", async () => {
		await recordReport({ deviceHash: "device-e", stopId: "s1", lineId: "56" });
		const result = await checkLimit({
			deviceHash: "device-e",
			stopId: "s2",
			lineId: "57",
		});
		expect(result.allowed).toBe(false);
		expect(result.reason).toBe("min_interval");
	});
});

describe("Clustering Logic", () => {
	let arret;

	beforeEach(async () => {
		arret = await makeArret();
	});

	test("does not publish cluster with only 2 reports", async () => {
		const s1 = await makeSignalement({ arret, reporterDeviceHash: "d1" });
		const s2 = await makeSignalement({ arret, reporterDeviceHash: "d2" });

		await assignSignalementToCluster(s1);
		await assignSignalementToCluster(s2);

		const cluster = await Cluster.findOne({ ligne: "56", arretId: arret._id });
		expect(cluster).toBeTruthy();
		expect(cluster.reportCount).toBeLessThan(3);
		expect(cluster.status).toBe("unpublished");
	});

	test("publishes cluster with 3 unique reports + trust >= 50", async () => {
		const s1 = await makeSignalement({ arret, reporterDeviceHash: "d1", trust: 50 });
		const s2 = await makeSignalement({ arret, reporterDeviceHash: "d2", trust: 60 });
		const s3 = await makeSignalement({ arret, reporterDeviceHash: "d3", trust: 75 });

		await assignSignalementToCluster(s1);
		await assignSignalementToCluster(s2);
		const result = await assignSignalementToCluster(s3);

		expect(result.published).toBe(true);
		expect(result.cluster.reportCount).toBe(3);
		expect(result.cluster.aggregateTrust).toBeGreaterThanOrEqual(50);
		expect(result.cluster.status).toBe("active");
	});

	test("deduplicates contributors by deviceHash", async () => {
		const s1 = await makeSignalement({ arret, reporterDeviceHash: "same-device" });
		const s2 = await makeSignalement({ arret, reporterDeviceHash: "same-device" });
		const s3 = await makeSignalement({ arret, reporterDeviceHash: "same-device" });

		await assignSignalementToCluster(s1);
		await assignSignalementToCluster(s2);
		const result = await assignSignalementToCluster(s3);

		expect(result.cluster.reportCount).toBe(1);
		expect(result.published).toBe(false);
	});

	test("active cluster appears in getActiveClusters", async () => {
		for (let i = 0; i < 3; i++) {
			const sig = await makeSignalement({ arret, reporterDeviceHash: `dev-${i}`, trust: 60 });
			await assignSignalementToCluster(sig);
		}

		const active = await getActiveClusters({});
		expect(active.length).toBeGreaterThanOrEqual(1);
		expect(active[0].ligne).toBe("56");
		expect(active[0].status).toBe("active");
	});
});

describe("Resolution Voting", () => {
	let arret;
	let cluster;

	beforeEach(async () => {
		arret = await makeArret();
		for (let i = 0; i < 3; i++) {
			const sig = await makeSignalement({ arret, reporterDeviceHash: `voter-${i}`, trust: 70 });
			await assignSignalementToCluster(sig);
		}
		cluster = await Cluster.findOne({ ligne: "56", arretId: arret._id, status: "active" });
		expect(cluster).toBeTruthy();
	});

	test("still blocked vote increments counter and extends expiry", async () => {
		const before = cluster.expiresAt.getTime();
		const result = await confirmStillBlocked({
			clusterIndex: cluster.clusterIndex,
			actorHash: "voter-x",
		});

		expect(result.confirmationCount).toBe(1);
		const updated = await Cluster.findOne({ clusterIndex: cluster.clusterIndex });
		expect(updated.expiresAt.getTime()).toBeGreaterThanOrEqual(before);
	});

	test("3 resolve votes mark cluster resolved", async () => {
		await confirmResolved({ clusterIndex: cluster.clusterIndex, actorHash: "v1" });
		await confirmResolved({ clusterIndex: cluster.clusterIndex, actorHash: "v2" });
		const result = await confirmResolved({ clusterIndex: cluster.clusterIndex, actorHash: "v3" });

		expect(result.resolved).toBe(true);
		expect(result.confirmationCount).toBeGreaterThanOrEqual(3);

		const updated = await Cluster.findOne({ clusterIndex: cluster.clusterIndex });
		expect(updated.status).toBe("resolved");
	});

	test("2 resolve votes keep cluster active", async () => {
		await confirmResolved({ clusterIndex: cluster.clusterIndex, actorHash: "v1" });
		const result = await confirmResolved({ clusterIndex: cluster.clusterIndex, actorHash: "v2" });

		expect(result.resolved).toBe(false);
		expect(result.confirmationCount).toBe(2);

		const updated = await Cluster.findOne({ clusterIndex: cluster.clusterIndex });
		expect(updated.status).toBe("active");
	});
});

describe("Moderation Queue", () => {
	let arret;

	beforeEach(async () => {
		arret = await makeArret();
	});

	test("enqueueFlag creates pending item", async () => {
		const sig = await makeSignalement({ arret, reporterDeviceHash: "spammer" });
		const item = await enqueueFlag({
			signalement: sig,
			flagReason: "spam",
			flaggedBy: "system",
			spamScore: 75,
			spamReasons: ["url_detected"],
		});

		expect(item).toBeTruthy();
		expect(item.status).toBe("pending");
		expect(item.priority).toBeGreaterThan(50);
	});

	test("enqueueFlag deduplicates pending flags for same signalement", async () => {
		const sig = await makeSignalement({ arret, reporterDeviceHash: "spammer-2" });
		await enqueueFlag({ signalement: sig, flagReason: "spam", spamScore: 60 });
		await enqueueFlag({ signalement: sig, flagReason: "spam", spamScore: 90 });

		const items = await ModerationQueueItem.find({ signalementId: sig._id });
		expect(items.length).toBe(1);
		expect(items[0].spamScore).toBe(90);
	});

	test("listQueue sorts by priority desc, oldest first", async () => {
		const s1 = await makeSignalement({ arret, reporterDeviceHash: "a" });
		const s2 = await makeSignalement({ arret, reporterDeviceHash: "b" });
		await enqueueFlag({ signalement: s1, flagReason: "spam", spamScore: 50 });
		await enqueueFlag({ signalement: s2, flagReason: "offensive", spamScore: 90 });

		const { items } = await listQueue({ limit: 10 });
		expect(items.length).toBeGreaterThanOrEqual(2);
		expect(items[0].priority).toBeGreaterThanOrEqual(items[1].priority);
	});

	test("approve action keeps signalement visible", async () => {
		const sig = await makeSignalement({ arret, reporterDeviceHash: "approve-target" });
		const flag = await enqueueFlag({ signalement: sig, flagReason: "spam" });

		await applyAction({ flagId: flag._id, action: "approve" });

		const updated = await Signalement.findById(sig._id);
		expect(updated.moderationStatus).toBe("approved");
		expect(updated.flagged).toBe(false);
	});

	test("remove action marks signalement as spam + bans device", async () => {
		process.env.NODE_ENV = "production";
		try {
			const sig = await makeSignalement({ arret, reporterDeviceHash: "removable" });
			await assignSignalementToCluster(sig);
			const flag = await enqueueFlag({ signalement: sig, flagReason: "spam", spamScore: 90 });

			const result = await applyAction({ flagId: flag._id, action: "remove", reason: "Confirmed spam" });

			const updated = await Signalement.findById(sig._id);
			expect(updated.status).toBe("spam");
			expect(updated.moderationStatus).toBe("rejected");
			expect(result.banApplied).toBe(true);
		} finally {
			process.env.NODE_ENV = "test";
		}
	});
});
