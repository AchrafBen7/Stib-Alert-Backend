const request = require("supertest");
const app = require("../app");
const { connect, disconnect, clearAll } = require("./mongoSetup");
const { registerAndLogin, createSignalement, ensureTestArret } = require("./helpers");
const Signalement = require("../models/Signalement");
const Utilisateur = require("../models/Utilisateur");
const { _test } = require("../services/transportService");

beforeAll(connect);
afterAll(disconnect);
beforeEach(clearAll);

async function approvedSignalementsForMap() {
	return Signalement.find({
		status: { $ne: "resolved" },
		moderationStatus: "approved",
	})
		.populate("arretId")
		.lean();
}

describe("community warning production flow", () => {
	it("creates a map warning after 3 reports, confirms still blocked, then hides it after 3 resolved votes", async () => {
		await ensureTestArret({
			stopId: "WARN071",
			nom: "Warning Stop 71",
			ligne: "71",
		});

		const reports = [];
		for (const email of ["warn1@test.com", "warn2@test.com", "warn3@test.com"]) {
			const { token } = await registerAndLogin(email);
			reports.push(await createSignalement(token, {
				nomArret: "Warning Stop 71",
				ligne: "71",
				description: `Signalement test ${email}`,
			}));
		}

		let clusters = _test.buildCommunityReportClusters(await approvedSignalementsForMap());
		expect(clusters).toHaveLength(1);
		expect(clusters[0]).toMatchObject({
			source: "community",
			line: "71",
			type: "Signalements nombreux",
		});
		expect(clusters[0].community.confirmations).toBe(3);

		const targetId = reports[0]._id || reports[0].id;
		const stillBlocked = await request(app)
			.post(`/api/signalements/${targetId}/still-blocked`)
			.set("x-stib-device-id", "community-device-blocked");

		expect(stillBlocked.status).toBe(200);
		expect(stillBlocked.body.community.stillBlocked).toBe(1);
		expect(stillBlocked.body.community.status).toBe("active");

		for (const deviceId of ["resolved-a", "resolved-b", "resolved-c"]) {
			const resolved = await request(app)
				.post(`/api/signalements/${targetId}/resolved`)
				.set("x-stib-device-id", deviceId);

			expect(resolved.status).toBe(200);
		}

		const resolvedSignalement = await Signalement.findById(targetId).lean();
		expect(resolvedSignalement.status).toBe("resolved");

		clusters = _test.buildCommunityReportClusters(await approvedSignalementsForMap());
		expect(clusters).toHaveLength(0);
	});

	it("keeps anonymous reports in moderation until an admin approves them", async () => {
		await ensureTestArret({
			stopId: "MOD071",
			nom: "Moderation Stop 71",
			ligne: "71",
		});

		const anonymous = await request(app)
			.post("/api/signalements")
			.set("x-stib-device-id", "moderation-anonymous-device")
			.send({
				nomArret: "Moderation Stop 71",
				ligne: "71",
				typeProbleme: "Retard",
				description: "Voir http://example.com",
			});

		expect(anonymous.status).toBe(201);
		const signalementId = anonymous.body.signalement._id || anonymous.body.signalement.id;
		expect(anonymous.body.signalement.moderationStatus).toBe("pending");

		const publicBefore = await request(app).get("/api/signalements?ligne=71");
		expect(publicBefore.status).toBe(200);
		expect(publicBefore.body.signalements.some((item) => String(item._id) === String(signalementId))).toBe(false);

		const { token, userId } = await registerAndLogin("admin@test.com");
		await Utilisateur.findByIdAndUpdate(userId, { role: "Admin" });
		const Redis = require("ioredis");
		Redis._reset?.();

		const pending = await request(app)
			.get("/api/signalements/moderation/pending")
			.set("Authorization", `Bearer ${token}`);

		expect(pending.status).toBe(200);
		expect(pending.body.signalements.some((item) => String(item._id) === String(signalementId))).toBe(true);

		const approved = await request(app)
			.post(`/api/signalements/moderation/${signalementId}/approve`)
			.set("Authorization", `Bearer ${token}`);

		expect(approved.status).toBe(200);
		expect(approved.body.signalement.moderationStatus).toBe("approved");

		const publicAfter = await request(app).get("/api/signalements?ligne=71");
		expect(publicAfter.status).toBe(200);
		expect(publicAfter.body.signalements.some((item) => String(item._id) === String(signalementId))).toBe(true);
	});
});
