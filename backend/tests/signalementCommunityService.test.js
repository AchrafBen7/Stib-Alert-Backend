const {
	COMMUNITY_ACTION,
	deriveCommunityStatus,
	upsertCommunityAction,
} = require("../services/signalementCommunityService");

describe("signalementCommunityService", () => {
	it("deduplicates anonymous community actions by actor hash", () => {
		const signalement = { communityEvents: [], confiance: "moyenne", dateSignalement: new Date() };

		upsertCommunityAction(signalement, { actorHash: "device-a" }, COMMUNITY_ACTION.STILL_BLOCKED);
		upsertCommunityAction(signalement, { actorHash: "device-a" }, COMMUNITY_ACTION.RESOLVED);

		expect(signalement.communityEvents).toHaveLength(1);
		expect(signalement.communityEvents[0].action).toBe(COMMUNITY_ACTION.RESOLVED);
	});

	it("marks a signalement as resolved after three distinct recent resolutions", () => {
		const now = new Date();
		const signalement = {
			communityEvents: [
				{ actorHash: "device-a", action: COMMUNITY_ACTION.RESOLVED, createdAt: now },
				{ actorHash: "device-b", action: COMMUNITY_ACTION.RESOLVED, createdAt: now },
				{ actorHash: "device-c", action: COMMUNITY_ACTION.RESOLVED, createdAt: now },
			],
			confiance: "moyenne",
			dateSignalement: now,
		};

		expect(deriveCommunityStatus(signalement, now).status).toBe("resolved");
	});
});
