// iRail real-time for SNCB/NMBS — liveboard (per-gare live departures with
// delays/cancellations) + disturbances (official NMBS perturbations).
//
// iRail (api.irail.be) is a free community API, completely separate from the
// Belgian Mobility API, so this adds ZERO load on that quota. We never poll:
// data is fetched lazily when a client asks, and served from an in-memory
// cache (per-gare liveboard ~60s, network disturbances ~3min) so even with
// many users iRail is hit at most a couple of times per minute.

const LIVE_TTL_MS = 60_000;
const DIST_TTL_MS = 180_000;
const REQUEST_TIMEOUT_MS = 8_000;
// iRail asks every client to send an identifying User-Agent.
const USER_AGENT = "StibAlert/1.0 (TFE student project; +https://github.com/AchrafBen7/StibAlert)";

const liveboardCache = new Map(); // irailId -> { at, data }
let disturbancesCache = { at: 0, data: [] };

// "gs:nmbssncb:S8814001" -> "BE.NMBS.008814001"
function gtfsToIrailId(gtfsId) {
	const match = String(gtfsId).match(/S?(\d{6,9})\s*$/);
	if (!match) return null;
	const digits = match[1].replace(/^0+/, "");
	return "BE.NMBS." + digits.padStart(9, "0");
}

function brusselsParts(unixSeconds) {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: "Europe/Brussels",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	}).formatToParts(new Date(unixSeconds * 1000));
	const get = (t) => parts.find((p) => p.type === t)?.value;
	const hour = parseInt(get("hour"), 10) || 0;
	const minute = parseInt(get("minute"), 10) || 0;
	return { hour, minute };
}

function brusselsMinutes(unixSeconds) {
	const { hour, minute } = brusselsParts(unixSeconds);
	return hour * 60 + minute;
}

function brusselsHHMM(unixSeconds) {
	const { hour, minute } = brusselsParts(unixSeconds);
	return String(hour).padStart(2, "0") + ":" + String(minute).padStart(2, "0");
}

// "IC 538" -> "IC", "S1 1880" -> "S1", else fall back to the GTFS-ish type.
function lineCode(vehicleinfo) {
	if (!vehicleinfo) return "";
	const shortname = (vehicleinfo.shortname || "").trim();
	if (shortname) return shortname.split(/\s+/)[0];
	return vehicleinfo.type || "";
}

async function getJSON(url) {
	if (typeof fetch !== "function") {
		throw new Error("global fetch unavailable (Node 18+ required)");
	}
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		const res = await fetch(url, {
			signal: controller.signal,
			headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
		});
		if (!res.ok) throw new Error("iRail HTTP " + res.status);
		return await res.json();
	} finally {
		clearTimeout(timer);
	}
}

async function fetchLiveboard(irailId) {
	const url = `https://api.irail.be/liveboard/?id=${encodeURIComponent(irailId)}&format=json&lang=fr&alerts=true`;
	const json = await getJSON(url);
	const list = json?.departures?.departure || [];
	return list.map((d) => {
		const delaySec = parseInt(d.delay, 10) || 0;
		const ts = parseInt(d.time, 10) || 0;
		return {
			scheduledMinutes: ts ? brusselsMinutes(ts) : 0,
			time: ts ? brusselsHHMM(ts) : "",
			destination: d.station || d.stationinfo?.standardname || "",
			line: lineCode(d.vehicleinfo),
			delayMinutes: Math.round(delaySec / 60),
			canceled: d.canceled === "1" || d.canceled === 1,
			platform: d.platform || (d.platforminfo && d.platforminfo.name) || null,
		};
	});
}

async function fetchDisturbances() {
	const url = "https://api.irail.be/disturbances/?format=json&lang=fr";
	const json = await getJSON(url);
	const list = json?.disturbance || [];
	return list.map((x, i) => ({
		id: String(x.id != null ? x.id : i),
		title: x.title || "",
		description: x.description || "",
		type: x.type || null,
		link: x.link || null,
	}));
}

// Lazy, cached. Returns the gare's live departures + the network disturbances.
async function realtime(gtfsStationId) {
	const now = Date.now();

	if (now - disturbancesCache.at > DIST_TTL_MS) {
		try {
			disturbancesCache = { at: now, data: await fetchDisturbances() };
		} catch (error) {
			console.warn("[irail] disturbances fetch failed:", error.message);
			disturbancesCache.at = now; // back off; keep stale data
		}
	}

	let departures = [];
	const irailId = gtfsToIrailId(gtfsStationId);
	if (irailId) {
		const cached = liveboardCache.get(irailId);
		if (cached && now - cached.at < LIVE_TTL_MS) {
			departures = cached.data;
		} else {
			try {
				departures = await fetchLiveboard(irailId);
				liveboardCache.set(irailId, { at: now, data: departures });
			} catch (error) {
				console.warn("[irail] liveboard fetch failed:", error.message);
				departures = cached?.data || [];
			}
		}
	}

	return {
		stationId: gtfsStationId,
		fetchedAt: new Date().toISOString(),
		departures,
		disruptions: disturbancesCache.data,
	};
}

module.exports = { realtime, gtfsToIrailId };
