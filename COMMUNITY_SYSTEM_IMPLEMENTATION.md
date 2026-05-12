# Community Reporting System — Implementation Complete

**Date:** 2026-05-12
**Status:** ✅ **CODE READY FOR TESTING**
**Target launch:** May 27, 2026

---

## 📦 What was built

### Backend (Node.js + Express + MongoDB)

**3 new models** in `backend/models/`:
- `Cluster.js` — Aggregated alerts (3+ similar signalements)
- `ModerationQueueItem.js` — Flag queue for admin review
- `DeviceLimit.js` — Anti-spam device tracking
- **Extended:** `Signalement.js` (+ trust, spamScore, clusterIndex, expiresAt, etc.)

**6 new services** in `backend/services/`:
- `spamDetectorService.js` — URL/keyword/similarity/geo spam scoring
- `communityRateLimiterService.js` — 5/hour, 20/day, same-stop limits + bans
- `trustScorerService.js` — 0-100 score (guest 50, user 75, official 100)
- `clusterService.js` — Group reports into clusters, publish/resolve/expire
- `moderationService.js` — Queue management, admin actions
- `communityJobsService.js` — Background sweeps (clustering, expiration, cleanup)

**2 new controllers + routes**:
- `controllers/clusterController.js` + `routes/clusterRoutes.js`
- `controllers/moderationController.js` + `routes/moderationRoutes.js`

**Updated:** `controllers/signalementController.js` (full pipeline)

**Wired in:** `app.js` (new mounts) + `server.js` (startCommunityJobs)

### iOS (SwiftUI)

**2 new networking files**:
- `Networking/ClusterService.swift` — API client + DTOs
- `Networking/SignalementService.swift` — already existed

**2 new UI components**:
- `View/Home/Components/ClusterMarker.swift` — Map pin with confidence color, icon, count
- `View/Home/Components/ClusterDetailSheet.swift` — Bottom sheet with reports, vote buttons

---

## 🔄 Full pipeline

```
User taps "Signaler problème"
  └─> POST /api/signalements
      │
      ├─ checkLimit(deviceHash) → 429 if rate limit hit
      ├─ analyserSignalement() (OpenAI, optional)
      ├─ calculateTrust(user, device) → 40-100
      ├─ scoreSpam(description, geo, history) → 0-100
      │   ├─ score >= 95 → 429 (ban)
      │   ├─ score >= 85 → 400 (reject)
      │   └─ score >= 70 → status=pending + enqueueFlag
      ├─ create Signalement
      ├─ recordReport(deviceHash) → update DeviceLimit
      └─ assignSignalementToCluster()
          ├─ findOrCreateCluster(lineId, stopId, type)
          ├─ recomputeClusterFromReports()
          │   ├─ uniqueContributors (dedup by user/device)
          │   ├─ aggregateTrust = avg(reports.trust)
          │   └─ confidence = high/medium/low
          ├─ if reportCount >= 3 AND avgTrust >= 50 → status="active" (PUBLISHED)
          └─ else → status="unpublished" (invisible)

Background jobs (every 30s):
  └─> runClusteringSweep() — picks up orphans, archives expired

User views map
  └─> GET /api/clusters/active?bbox=...&limit=100
      └─ Returns published clusters within bbox

User taps cluster
  └─> GET /api/clusters/{index}
      └─ Returns detail + sample signalements

User votes "Toujours bloqué"
  └─> POST /api/clusters/{index}/still-blocked
      ├─ stillBlockedConfirmationCount++
      └─ expiresAt extended by 2h (max 4h total lifetime)

User votes "C'est résolu"
  └─> POST /api/clusters/{index}/resolve
      ├─ resolveConfirmationCount++
      └─ if count >= 3 → status="resolved", reports.status="resolved"

Background jobs (every minute):
  └─> expirationTick() — archive clusters past expiresAt
  └─> dailyCleanup() — unban expired bans, reset counters
```

---

## 🛡️ Anti-spam summary

| Layer | Mechanism | Threshold |
|---|---|---|
| 1. Rate limit (hourly) | Per device | 5 reports/hour |
| 2. Rate limit (daily) | Per device | 20 reports/day |
| 3. Same stop | Per device | 2 reports/hour |
| 4. Same line | Per device | 3 reports/hour |
| 5. Min interval | Per device | 15 seconds |
| 6. Spam scoring | Description analysis | flag@70 / reject@85 / ban@95 |
| 7. Auto-ban (temp) | After flags | 10 flags → 24h ban |
| 8. Auto-ban (perm) | After flags | 50 flags → permanent |

Spam scoring detects:
- URLs / emails / phone numbers (50/35/20 pts)
- Spam keywords (casino, crypto, etc.) — 20 pts each
- Offensive keywords — 25 pts each
- Geographic outliers (>500m from stop) — 25 pts
- Rapid-fire (3+ in 5 min) — 30 pts
- Duplicate from same device — 60 pts
- High similarity cluster — 30 pts

---

## 🔌 New API endpoints

```
# Community clusters
GET    /api/clusters/active?bbox=lat,lng,lat,lng&ligne=56&limit=100
GET    /api/clusters/:clusterIndex
POST   /api/clusters/:clusterIndex/still-blocked
POST   /api/clusters/:clusterIndex/resolve

# User flag
POST   /api/signalements/:id/flag  body: { reason: "spam|offensive|...", note? }

# Admin moderation (requires admin auth)
GET    /admin/moderation/queue?status=pending&priority=high&limit=50
GET    /admin/moderation/summary
POST   /admin/moderation/:flagId/action  body: { action: "approve|reject|remove|escalate", reason? }
```

---

## ✅ Testing

**`tests/clusterSystem.test.js`** validates:
- Spam scoring: empty / URL / spam keywords / legit / geo outliers
- Trust scoring: guest / authenticated / official
- Rate limiting: hourly, daily, same stop, rapid-fire, device ban
- Clustering: <3 reports unpublished, 3 unique reports published, dedup same device
- Resolution: still-blocked extends, 3 resolved votes mark resolved
- Moderation: enqueue, dedup, sort by priority, approve/reject/remove actions

Run with: `npm test -- clusterSystem`

---

## 🚀 Configuration

Environment variables (with defaults):

```bash
# Privacy
SIGNALEMENT_PRIVACY_SALT=...  # Used for SHA256(IP/device)
SIGNALEMENT_TTL_DAYS=30

# Community jobs
COMMUNITY_JOBS_ENABLED=true  # set to "false" to disable
COMMUNITY_CLUSTERING_INTERVAL_MS=30000   # 30 sec
COMMUNITY_EXPIRATION_INTERVAL_MS=60000   # 1 min
COMMUNITY_CLEANUP_INTERVAL_MS=3600000    # 1 hour
```

---

## 📱 iOS integration steps

1. Add new files to Xcode project:
   - `Networking/ClusterService.swift`
   - `View/Home/Components/ClusterMarker.swift`
   - `View/Home/Components/ClusterDetailSheet.swift`

2. Replace existing community markers with `ClusterMarker(cluster: ...)` in HomeView's MapKit annotations layer.

3. Periodically fetch clusters in HomeView:
   ```swift
   .task(id: cameraCenterCoordinate) {
       let bbox = BoundingBox(center: cameraCenterCoordinate, radiusMeters: 5000)
       let response = try? await ClusterService.active(bbox: bbox, limit: 200)
       activeClusters = response?.clusters ?? []
   }
   ```

4. On cluster tap, present `ClusterDetailSheet(clusterIndex:, onClose:)` as overlay.

---

## 📊 What changed vs design

Faithfully implemented per `COMMUNITY_SYSTEM_MVP.md`:
- ✅ 3-layer anti-spam (rate limit + duplicates + spam scoring)
- ✅ Trust scoring (guest 50 / user 75 / verified +10 / age +5 / accuracy ±10)
- ✅ Clustering (3+ unique contributors + avgTrust >= 50 → publish)
- ✅ Resolution voting (3 confirms → resolved)
- ✅ Still-blocked voting (extends expiry, max 4h lifetime)
- ✅ Moderation queue (4 actions: approve/reject/remove/escalate)
- ✅ Auto-ban (10 flags → 24h, 50 → permanent)
- ✅ Background jobs (30s clustering, 1min expiration, 1h cleanup)
- ✅ Official STIB alerts kept separate (isOfficial flag on Cluster)
- ✅ iOS map markers (color by confidence, icon by type, count badge)
- ✅ iOS detail sheet (reports + vote buttons + toast feedback)

**Differences from spec:**
- Uses existing `Signalement` model (extended), not a new collection
- Uses existing `Arret` references rather than separate `stopId` strings
- Reuses existing privacy hash mechanism (`SIGNALEMENT_PRIVACY_SALT`)
- iOS detail sheet uses overlay style matching existing HomeView pattern

---

## ⏭️ Next steps

1. **Run tests:** `npm test -- clusterSystem`
2. **Add HomeView wiring** for fetching/displaying clusters
3. **Wire admin dashboard** (HTML table — see roadmap Day 6)
4. **Staging deployment** + smoke test
5. **TestFlight build** with cluster UI
6. **Production deploy** (May 25-27)

---

**~1100 lines of backend code + ~700 lines of iOS code + tests.**
**No new dependencies. Backward compatible. Ready for QA.**
