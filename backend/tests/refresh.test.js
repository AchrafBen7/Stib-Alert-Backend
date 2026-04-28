const request = require("supertest");
const app = require("../app");
const { connect, disconnect, clearAll } = require("./mongoSetup");
const { registerAndLogin } = require("./helpers");

beforeAll(connect);
afterAll(disconnect);
beforeEach(clearAll);

describe("POST /api/utilisateurs/refresh", () => {
    it("returns 200 with new token and new refreshToken on valid refresh token", async () => {
        const { refreshToken } = await registerAndLogin("refresh1@test.com");

        const res = await request(app)
            .post("/api/utilisateurs/refresh")
            .send({ refreshToken });

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty("token");
        expect(res.body).toHaveProperty("refreshToken");
        expect(res.body.token).toBeTruthy();
        expect(res.body.refreshToken).not.toBe(refreshToken); // rotated
    });

    it("new token from refresh grants access to protected routes", async () => {
        const { refreshToken } = await registerAndLogin("refresh2@test.com");

        const refreshRes = await request(app)
            .post("/api/utilisateurs/refresh")
            .send({ refreshToken });
        const newToken = refreshRes.body.token;

        const me = await request(app)
            .get("/api/utilisateurs/me")
            .set("Authorization", `Bearer ${newToken}`);

        expect(me.status).toBe(200);
        expect(me.body).toHaveProperty("email", "refresh2@test.com");
    });

    it("returns 401 for invalid refresh token", async () => {
        const res = await request(app)
            .post("/api/utilisateurs/refresh")
            .send({ refreshToken: "totallyinvalidtoken" });

        expect(res.status).toBe(401);
    });

    it("returns 400 when refreshToken is missing from body", async () => {
        const res = await request(app)
            .post("/api/utilisateurs/refresh")
            .send({});

        expect(res.status).toBe(400);
    });

    it("old refresh token is rejected after rotation (single use)", async () => {
        const { refreshToken: original } = await registerAndLogin("refresh5@test.com");

        // Use the original token once
        const first = await request(app)
            .post("/api/utilisateurs/refresh")
            .send({ refreshToken: original });
        expect(first.status).toBe(200);

        // Same original token should now be rejected
        const second = await request(app)
            .post("/api/utilisateurs/refresh")
            .send({ refreshToken: original });
        expect(second.status).toBe(401);
    });

    it("refresh token is rejected after logout", async () => {
        const { token, refreshToken } = await registerAndLogin("refresh6@test.com");

        await request(app)
            .post("/api/utilisateurs/deconnexion")
            .set("Authorization", `Bearer ${token}`);

        const res = await request(app)
            .post("/api/utilisateurs/refresh")
            .send({ refreshToken });

        expect(res.status).toBe(401);
    });
});
