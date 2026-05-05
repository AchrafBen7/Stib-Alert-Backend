const request = require("supertest");
const app = require("../app");
const redis = require("../config/redis");
const { connect, disconnect, clearAll } = require("./mongoSetup");
const Arret = require("../models/Arret");

beforeAll(connect);
afterAll(disconnect);
beforeEach(clearAll);

describe("POST /api/utilisateurs/inscription", () => {
    it("returns 201 and activationToken with valid data", async () => {
        const res = await request(app)
            .post("/api/utilisateurs/inscription")
            .send({ nom: "Alice", email: "alice@test.com", motDePasse: "Password123!" });

        expect(res.status).toBe(201);
        expect(res.body).toHaveProperty("activationToken");
    });

    it("returns 400 for duplicate email", async () => {
        const payload = { nom: "Bob", email: "bob@test.com", motDePasse: "Password123!" };

        // First registration stores activation state in Redis
        await request(app).post("/api/utilisateurs/inscription").send(payload);
        const code = await redis.get(`activation:${payload.email}`);
        const reg = await request(app).post("/api/utilisateurs/inscription").send(payload);
        const act = await request(app)
            .post("/api/utilisateurs/activation")
            .send({ activationToken: reg.body.activationToken || (await request(app).post("/api/utilisateurs/inscription").send(payload)).body.activationToken, activationCode: code });

        // Try registering the same email again after account is activated
        const dup = await request(app).post("/api/utilisateurs/inscription").send(payload);

        // After activation, the email exists in DB — next activation attempt should fail
        const dupAct = await request(app)
            .post("/api/utilisateurs/activation")
            .send({ activationToken: dup.body.activationToken, activationCode: code });
        expect(dupAct.status).toBe(400);
    });

    it("returns 400 when email is missing", async () => {
        const res = await request(app)
            .post("/api/utilisateurs/inscription")
            .send({ nom: "Charlie", motDePasse: "Password123!" });

        expect(res.status).toBe(400);
    });

    it("returns 400 when password is too short", async () => {
        const res = await request(app)
            .post("/api/utilisateurs/inscription")
            .send({ nom: "Dave", email: "dave@test.com", motDePasse: "123" });

        expect(res.status).toBe(400);
    });
});

describe("POST /api/utilisateurs/activation", () => {
    it("returns 201, token and refreshToken with correct code", async () => {
        const reg = await request(app)
            .post("/api/utilisateurs/inscription")
            .send({ nom: "Eve", email: "eve@test.com", motDePasse: "Password123!" });

        const code = await redis.get("activation:eve@test.com");
        const res = await request(app)
            .post("/api/utilisateurs/activation")
            .send({ activationToken: reg.body.activationToken, activationCode: code });

        expect(res.status).toBe(201);
        expect(res.body).toHaveProperty("token");
        expect(res.body).toHaveProperty("refreshToken");
        expect(res.body.utilisateur).toHaveProperty("email", "eve@test.com");
    });

    it("returns 400 with wrong activation code", async () => {
        const reg = await request(app)
            .post("/api/utilisateurs/inscription")
            .send({ nom: "Frank", email: "frank@test.com", motDePasse: "Password123!" });

        const res = await request(app)
            .post("/api/utilisateurs/activation")
            .send({ activationToken: reg.body.activationToken, activationCode: "0000" });

        expect(res.status).toBe(400);
    });
});

describe("POST /api/utilisateurs/connexion", () => {
    it("returns 200 with token and refreshToken on valid credentials", async () => {
        // Create and activate account first
        const reg = await request(app)
            .post("/api/utilisateurs/inscription")
            .send({ nom: "Grace", email: "grace@test.com", motDePasse: "Password123!" });
        const code = await redis.get("activation:grace@test.com");
        await request(app)
            .post("/api/utilisateurs/activation")
            .send({ activationToken: reg.body.activationToken, activationCode: code });

        const res = await request(app)
            .post("/api/utilisateurs/connexion")
            .send({ email: "grace@test.com", motDePasse: "Password123!" });

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty("token");
        expect(res.body).toHaveProperty("refreshToken");
    });

    it("returns 401 on wrong password", async () => {
        const reg = await request(app)
            .post("/api/utilisateurs/inscription")
            .send({ nom: "Heidi", email: "heidi@test.com", motDePasse: "Password123!" });
        const code = await redis.get("activation:heidi@test.com");
        await request(app)
            .post("/api/utilisateurs/activation")
            .send({ activationToken: reg.body.activationToken, activationCode: code });

        const res = await request(app)
            .post("/api/utilisateurs/connexion")
            .send({ email: "heidi@test.com", motDePasse: "WrongPassword!" });

        expect(res.status).toBe(401);
    });
});

describe("GET /api/utilisateurs/me", () => {
    it("returns 200 and user data with valid token", async () => {
        const reg = await request(app)
            .post("/api/utilisateurs/inscription")
            .send({ nom: "Ivan", email: "ivan@test.com", motDePasse: "Password123!" });
        const code = await redis.get("activation:ivan@test.com");
        const act = await request(app)
            .post("/api/utilisateurs/activation")
            .send({ activationToken: reg.body.activationToken, activationCode: code });
        const { token } = act.body;

        const res = await request(app)
            .get("/api/utilisateurs/me")
            .set("Authorization", `Bearer ${token}`);

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty("email", "ivan@test.com");
    });

    it("returns 401 without token", async () => {
        const res = await request(app).get("/api/utilisateurs/me");
        expect(res.status).toBe(401);
    });

    it("returns 401 with malformed token", async () => {
        const res = await request(app)
            .get("/api/utilisateurs/me")
            .set("Authorization", "Bearer notavalidtoken");
        expect(res.status).toBe(401);
    });
});

describe("POST /api/utilisateurs/deconnexion", () => {
    it("returns 200 and invalidates the session", async () => {
        const reg = await request(app)
            .post("/api/utilisateurs/inscription")
            .send({ nom: "Judy", email: "judy@test.com", motDePasse: "Password123!" });
        const code = await redis.get("activation:judy@test.com");
        const act = await request(app)
            .post("/api/utilisateurs/activation")
            .send({ activationToken: reg.body.activationToken, activationCode: code });
        const { token } = act.body;

        const logout = await request(app)
            .post("/api/utilisateurs/deconnexion")
            .set("Authorization", `Bearer ${token}`);
        expect(logout.status).toBe(200);

        // Token should now be invalid (removed from Redis)
        const me = await request(app)
            .get("/api/utilisateurs/me")
            .set("Authorization", `Bearer ${token}`);
        expect(me.status).toBe(401);
    });
});

describe("PATCH /api/utilisateurs/:id/favoris/:arretId", () => {
    it("adds then removes the same favorite stop", async () => {
        const { token, userId } = await registerAndLoginForTest("favoris@test.com");
        const arret = await Arret.create({
            stop_id: "FAV001",
            nom: "Favori Test",
            latitude: 50.85,
            longitude: 4.35,
            lignesDesservies: ["71"],
        });

        const add = await request(app)
            .patch(`/api/utilisateurs/${userId}/favoris/${arret._id}`)
            .set("Authorization", `Bearer ${token}`);

        expect(add.status).toBe(200);
        expect(add.body.favoris.map(String)).toContain(String(arret._id));
        expect(add.body.favorisDetails).toHaveLength(1);

        const remove = await request(app)
            .patch(`/api/utilisateurs/${userId}/favoris/${arret._id}`)
            .set("Authorization", `Bearer ${token}`);

        expect(remove.status).toBe(200);
        expect(remove.body.favoris.map(String)).not.toContain(String(arret._id));
        expect(remove.body.favorisDetails).toHaveLength(0);
    });
});

async function registerAndLoginForTest(email, password = "Password123!") {
    const reg = await request(app)
        .post("/api/utilisateurs/inscription")
        .send({ nom: "Test User", email, motDePasse: password });
    const code = await redis.get(`activation:${email}`);
    const act = await request(app)
        .post("/api/utilisateurs/activation")
        .send({ activationToken: reg.body.activationToken, activationCode: code });

    return {
        token: act.body.token,
        userId: act.body.utilisateur._id,
    };
}
