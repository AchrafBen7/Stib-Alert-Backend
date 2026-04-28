const request = require("supertest");
const app = require("../app");
const redis = require("../config/redis");

// Creates a user, activates it, and returns { token, refreshToken, userId }
async function registerAndLogin(email = "test@example.com", password = "Password123!") {
    // Step 1: Register
    const reg = await request(app)
        .post("/api/utilisateurs/inscription")
        .send({ nom: "Test User", email, motDePasse: password });

    if (reg.status !== 201) throw new Error(`Inscription failed: ${JSON.stringify(reg.body)}`);
    const { activationToken } = reg.body;

    // Step 2: Retrieve OTP code from mock Redis
    const code = await redis.get(`activation:${email}`);
    if (!code) throw new Error("Activation code not found in Redis mock");

    // Step 3: Activate
    const act = await request(app)
        .post("/api/utilisateurs/activation")
        .send({ activationToken, activationCode: code });

    if (act.status !== 201) throw new Error(`Activation failed: ${JSON.stringify(act.body)}`);

    return {
        token: act.body.token,
        refreshToken: act.body.refreshToken,
        userId: act.body.utilisateur._id,
        utilisateur: act.body.utilisateur,
    };
}

// Creates a signalement via the API and returns the created document
async function createSignalement(token, overrides = {}) {
    const payload = {
        ligne: "71",
        typeProbleme: "Retard",
        description: "Test signalement description",
        latitude: 50.85,
        longitude: 4.35,
        ...overrides,
    };

    const res = await request(app)
        .post("/api/signalements")
        .set("Authorization", `Bearer ${token}`)
        .send(payload);

    if (res.status !== 201) throw new Error(`Create signalement failed: ${JSON.stringify(res.body)}`);
    return res.body.signalement || res.body;
}

module.exports = { registerAndLogin, createSignalement };
