const request = require("supertest");
const app = require("../app");
const mongoose = require("mongoose");
const { connect, disconnect, clearAll } = require("./mongoSetup");
const { registerAndLogin, ensureTestArret } = require("./helpers");

const Cluster = require("../models/Cluster");
const Signalement = require("../models/Signalement");
const Arret = require("../models/Arret");
const Utilisateur = require("../models/Utilisateur");

beforeAll(connect);
afterAll(disconnect);
beforeEach(clearAll);

// E2E happy-path: a logged-in user with a routine touches the full chain
//   1. POST /api/signalements -> creates a Signalement
//   2. Two more anonymous reports trigger Cluster publication
//   3. GET /api/clusters/active -> the cluster is visible
//   4. GET /api/decision?lat=...&lng=... -> verdict mentions the cluster
//   5. POST /api/clusters/:idx/resolve x N -> cluster resolves
describe("E2E — full decision flow", () => {
	async function seedArret(name = "Gallait", line = "56") {
		return ensureTestArret({
			stopId: `E2E_${Date.now()}_${Math.random()}`,
			nom: name,
			ligne: line,
		});
	}

	it("publishes a cluster after 3 reports and surfaces it via /api/decision", async () => {
		const arretName = await seedArret();
		const arret = await Arret.findOne({ nom: arretName });

		// Three different devices report Retard on ligne 56 at this stop.
		const devices = ["e2e-d1", "e2e-d2", "e2e-d3"];
		for (const deviceId of devices) {
			const res = await request(app)
				.post("/api/signalements")
				.set("x-stib-device-id", deviceId)
				.send({
					nomArret: arretName,
					ligne: "56",
					typeProbleme: "Retard",
					description: `Tram 56 en retard ${deviceId}`,
					latitude: arret.latitude,
					longitude: arret.longitude,
				});
			expect(res.status).toBe(201);
		}

		// Verify a Cluster row exists with reportCount=3, status=active
		const cluster = await Cluster.findOne({
			ligne: "56",
			arretId: arret._id,
			status: "active",
		});
		expect(cluster).toBeTruthy();
		expect(cluster.reportCount).toBeGreaterThanOrEqual(3);
		expect(cluster.confidence).toMatch(/^(medium|high)$/);

		// /api/clusters/active includes it
		const listRes = await request(app)
			.get("/api/clusters/active")
			.query({
				bbox: `${arret.latitude - 0.05},${arret.longitude - 0.05},${arret.latitude + 0.05},${arret.longitude + 0.05}`,
			});
		expect(listRes.status).toBe(200);
		const visibleIndexes = listRes.body.clusters.map((c) => c.clusterIndex);
		expect(visibleIndexes).toContain(cluster.clusterIndex);

		// /api/decision returns a verdict referencing the cluster (line=56 forces scope)
		const decisionRes = await request(app)
			.get("/api/decision")
			.query({
				lat: arret.latitude,
				lng: arret.longitude,
				ligne: "56",
			});
		expect(decisionRes.status).toBe(200);
		expect(["CAUTION", "AVOID"]).toContain(decisionRes.body.verdict);
		expect(decisionRes.body.affectedCluster).toBeTruthy();
		expect(decisionRes.body.affectedCluster.ligne).toBe("56");
	});

	it("trip mode returns a verdict comparing routes by disruption", async () => {
		const origin = await seedArret("Origin Stop", "56");
		const dest = await seedArret("Dest Stop", "92");

		const originArret = await Arret.findOne({ nom: origin });
		const destArret = await Arret.findOne({ nom: dest });

		// Seed 3 reports on ligne 56 to publish a cluster.
		for (const deviceId of ["t1", "t2", "t3"]) {
			await request(app)
				.post("/api/signalements")
				.set("x-stib-device-id", deviceId)
				.send({
					nomArret: origin,
					ligne: "56",
					typeProbleme: "Retard",
					description: `Retard ${deviceId}`,
					latitude: originArret.latitude,
					longitude: originArret.longitude,
				});
		}

		const decisionRes = await request(app)
			.get("/api/decision")
			.query({
				lat: originArret.latitude,
				lng: originArret.longitude,
				destLat: destArret.latitude,
				destLng: destArret.longitude,
				destLabel: "Dest Stop",
			});
		expect(decisionRes.status).toBe(200);
		expect(decisionRes.body.tripMode).toBe(true);
		expect(decisionRes.body.headline).toBeDefined();
		// Google Directions may not be configured in test env, so bestRoute may be null.
		// The endpoint should still respond with a verdict.
		expect(["ALL_CLEAR", "WATCH", "CAUTION", "AVOID"]).toContain(decisionRes.body.verdict);
	});
});
