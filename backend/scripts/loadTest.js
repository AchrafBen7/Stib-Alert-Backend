#!/usr/bin/env node
/**
 * Load test script — simule un pic de signalements pour valider la pipeline.
 *
 * Usage:
 *   node scripts/loadTest.js
 *   API_URL=https://staging.stibalert.be node scripts/loadTest.js
 *   CONCURRENCY=100 DURATION_S=30 node scripts/loadTest.js
 */

const API_URL = process.env.API_URL || "http://localhost:4000";
const CONCURRENCY = parseInt(process.env.CONCURRENCY, 10) || 50;
const DURATION_S = parseInt(process.env.DURATION_S, 10) || 10;
const STOP_NOM = process.env.STOP_NOM || "DOCKS BRUXSEL";
const LIGNE = process.env.LIGNE || "56";
const TYPES = ["Retard", "Panne", "Travaux", "Perturbation"];

const stats = {
	total: 0,
	success: 0,
	error: 0,
	rateLimited: 0,
	spam: 0,
	durations: [],
	byStatus: {},
};

async function sendOne(workerId) {
	const start = Date.now();
	const deviceId = `loadtest-${workerId}-${Math.random().toString(36).slice(2, 10)}`;
	const description = `Test load ${workerId} ${Date.now()}`;
	const typeProbleme = TYPES[Math.floor(Math.random() * TYPES.length)];

	try {
		const res = await fetch(`${API_URL}/api/signalements`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-stib-device-id": deviceId,
			},
			body: JSON.stringify({
				nomArret: STOP_NOM,
				ligne: LIGNE,
				typeProbleme,
				description,
				latitude: 50.85,
				longitude: 4.35,
			}),
		});

		const duration = Date.now() - start;
		stats.total++;
		stats.durations.push(duration);
		stats.byStatus[res.status] = (stats.byStatus[res.status] || 0) + 1;

		if (res.status === 201) stats.success++;
		else if (res.status === 429) stats.rateLimited++;
		else if (res.status === 400) stats.spam++;
		else stats.error++;
	} catch (err) {
		stats.total++;
		stats.error++;
		console.error("[loadTest] fetch failed:", err.message);
	}
}

async function worker(id, endTime) {
	while (Date.now() < endTime) {
		await sendOne(id);
		await new Promise((r) => setTimeout(r, 50 + Math.random() * 100));
	}
}

function percentile(arr, p) {
	if (arr.length === 0) return 0;
	const sorted = [...arr].sort((a, b) => a - b);
	return sorted[Math.floor((sorted.length * p) / 100)];
}

async function main() {
	console.log(`🚀 Load test: ${CONCURRENCY} workers × ${DURATION_S}s → ${API_URL}`);
	console.log(`   Target: stop="${STOP_NOM}" ligne="${LIGNE}"`);

	const endTime = Date.now() + DURATION_S * 1000;
	const startTime = Date.now();

	const workers = Array.from({ length: CONCURRENCY }, (_, i) => worker(i, endTime));
	await Promise.all(workers);

	const elapsedS = (Date.now() - startTime) / 1000;
	const rps = stats.total / elapsedS;
	const p50 = percentile(stats.durations, 50);
	const p95 = percentile(stats.durations, 95);
	const p99 = percentile(stats.durations, 99);

	console.log("\n📊 Results:");
	console.log("─────────────────────────");
	console.log(`Total requests:    ${stats.total}`);
	console.log(`Elapsed:           ${elapsedS.toFixed(1)}s`);
	console.log(`Throughput:        ${rps.toFixed(1)} req/s`);
	console.log(`✓ Success (201):   ${stats.success} (${((stats.success / stats.total) * 100).toFixed(1)}%)`);
	console.log(`⚠ Rate-limited:    ${stats.rateLimited} (${((stats.rateLimited / stats.total) * 100).toFixed(1)}%)`);
	console.log(`✗ Spam blocked:    ${stats.spam}`);
	console.log(`✗ Other errors:    ${stats.error}`);
	console.log(`\nLatency:`);
	console.log(`  p50: ${p50}ms`);
	console.log(`  p95: ${p95}ms`);
	console.log(`  p99: ${p99}ms`);
	console.log(`\nBy status code:`, stats.byStatus);

	console.log("\n📋 Verdict:");
	if (p95 > 2000) {
		console.log("❌ P95 latency > 2s — slow under load");
	} else if (p95 > 500) {
		console.log("⚠️  P95 latency between 500ms and 2s — acceptable but watch");
	} else {
		console.log("✅ P95 latency < 500ms — solid");
	}

	if (stats.rateLimited === 0 && stats.success === stats.total) {
		console.log("⚠️  No rate limits triggered — verify anti-spam is enabled in this env");
	} else if (stats.rateLimited > stats.success * 0.5) {
		console.log("⚠️  >50% rate-limited — limits may be too tight for production");
	} else {
		console.log("✅ Rate limits triggered correctly under spike");
	}
}

main().catch((err) => {
	console.error("Fatal:", err);
	process.exit(1);
});
