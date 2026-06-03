const mongoose = require("mongoose");

// Un vote (still_blocked / resolved) par ACTEUR et par cluster.
// L'index unique composé empêche le double-vote : un même utilisateur OU
// appareil ne peut compter qu'une fois par type sur un cluster donné.
// Avant ce modèle, confirmResolved/confirmStillBlocked incrémentaient le
// compteur à chaque appel sans dédup → un seul utilisateur pouvait effacer
// (ou maintenir) artificiellement une alerte vécue par beaucoup d'autres.
const clusterVoteSchema = new mongoose.Schema(
	{
		clusterIndex: { type: Number, required: true, index: true },
		// "still_blocked" | "resolved"
		voteType: { type: String, required: true, enum: ["still_blocked", "resolved"] },
		// Clé d'acteur : "u:<userId>" si connecté, sinon "d:<deviceHash>".
		// On préfixe pour qu'un user et un device ne collisionnent jamais.
		actorKey: { type: String, required: true },
	},
	{ timestamps: true }
);

// Cœur de l'anti-double-vote : unicité (cluster, type, acteur).
clusterVoteSchema.index(
	{ clusterIndex: 1, voteType: 1, actorKey: 1 },
	{ unique: true, name: "cluster_vote_unique" }
);

// TTL : les votes se purgent 24 h après création (au-delà, le cluster est
// archivé de toute façon — pas besoin de garder l'historique de vote).
clusterVoteSchema.index(
	{ createdAt: 1 },
	{ expireAfterSeconds: 60 * 60 * 24, name: "cluster_vote_ttl" }
);

module.exports = mongoose.model("ClusterVote", clusterVoteSchema);
