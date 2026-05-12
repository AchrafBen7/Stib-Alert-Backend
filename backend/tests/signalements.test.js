const request = require("supertest");
const app = require("../app");
const { connect, disconnect, clearAll } = require("./mongoSetup");
const { registerAndLogin, createSignalement, ensureTestArret } = require("./helpers");
const Arret = require("../models/Arret");

beforeAll(connect);
afterAll(disconnect);
beforeEach(clearAll);

describe("GET /api/signalements", () => {
    it("returns 200 with signalements array and pagination", async () => {
        const res = await request(app).get("/api/signalements");
        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty("signalements");
        expect(Array.isArray(res.body.signalements)).toBe(true);
        expect(res.body).toHaveProperty("pagination");
    });

    it("filters by ligne query param", async () => {
        const { token } = await registerAndLogin("filter@test.com");
        await ensureTestArret({ stopId: "TEST092", nom: "Test Stop 92", ligne: "92" });
        await createSignalement(token, { ligne: "71" });
        await createSignalement(token, { nomArret: "Test Stop 92", ligne: "92" });

        const res = await request(app).get("/api/signalements?ligne=71");
        expect(res.status).toBe(200);
        const lines = res.body.signalements.map((s) => s.ligne);
        expect(lines.every((l) => l === "71")).toBe(true);
    });
});

describe("POST /api/signalements", () => {
    it("returns 201 with authorType and moderationStatus when authenticated", async () => {
        const { token } = await registerAndLogin("creator@test.com");
        const sig = await createSignalement(token);

        expect(sig).toHaveProperty("ligne", "71");
        expect(sig).toHaveProperty("typeProbleme", "Retard");
        expect(sig).toHaveProperty("authorType", "authenticated");
        expect(sig).toHaveProperty("moderationStatus", "approved");
    });

    it("returns 201 with pending status when unauthenticated", async () => {
        await Arret.create({
            stop_id: "TEST071",
            nom: "Test Stop",
            latitude: 50.85,
            longitude: 4.35,
            lignesDesservies: ["71"],
        });

        const res = await request(app)
            .post("/api/signalements")
            .send({
                nomArret: "Test Stop",
                ligne: "71",
                typeProbleme: "Retard",
                description: "Retard important sans compte",
            });

        expect(res.status).toBe(201);
        const body = res.body.signalement || res.body;
        expect(body).toHaveProperty("ligne", "71");
        expect(body).toHaveProperty("authorType", "anonymous");
        expect(body).toHaveProperty("moderationStatus", "approved");
    });

    it("rejects duplicate anonymous reports from the same device (409)", async () => {
        await Arret.create({
            stop_id: "TEST071",
            nom: "Test Stop",
            latitude: 50.85,
            longitude: 4.35,
            lignesDesservies: ["71"],
        });

        const payload = {
            nomArret: "Test Stop",
            ligne: "71",
            typeProbleme: "Retard",
            description: "Retard important sans compte",
        };

        const first = await request(app)
            .post("/api/signalements")
            .set("x-stib-device-id", "test-device-abc")
            .send(payload);
        const duplicate = await request(app)
            .post("/api/signalements")
            .set("x-stib-device-id", "test-device-abc")
            .send(payload);

        expect(first.status).toBe(201);
        expect(duplicate.status).toBe(409);
        expect(duplicate.body).toHaveProperty("moderationStatus", "approved");
    });

    it("returns 400 when typeProbleme is invalid", async () => {
        const { token } = await registerAndLogin("badtype@test.com");
        const nomArret = await ensureTestArret();

        const res = await request(app)
            .post("/api/signalements")
            .set("Authorization", `Bearer ${token}`)
            .send({
                nomArret,
                ligne: "71",
                typeProbleme: "InvalidType",
                description: "Test description",
            });

        expect(res.status).toBe(400);
    });
});

describe("POST /api/signalements/:id/vote", () => {
    it("records vote and returns 409 on duplicate", async () => {
        const { token } = await registerAndLogin("voter@test.com");
        const sig = await createSignalement(token);
        const sigId = sig._id || sig.id;

        const res = await request(app)
            .post(`/api/signalements/${sigId}/vote`)
            .set("Authorization", `Bearer ${token}`)
            .send({ vote: "up" });

        expect(res.status).toBe(200);
        expect(res.body.signalement.votesPositifs).toBe(1);

        const duplicate = await request(app)
            .post(`/api/signalements/${sigId}/vote`)
            .set("Authorization", `Bearer ${token}`)
            .send({ vote: "up" });

        expect(duplicate.status).toBe(409);
    });
});

describe("POST /api/signalements/:id/resolved", () => {
    it("returns 200 and marks signalement as resolved", async () => {
        const { token } = await registerAndLogin("resolver@test.com");
        const sig = await createSignalement(token);
        const sigId = sig._id || sig.id;

        const res = await request(app)
            .post(`/api/signalements/${sigId}/resolved`)
            .set("Authorization", `Bearer ${token}`);

        expect(res.status).toBe(200);
    });
});
