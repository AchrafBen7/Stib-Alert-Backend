# Blayse — Backend

Backend van **Blayse** (voorheen *StibAlert*): een Brusselse mobiliteitsapp die
reizigers omvormt tot een **realtime informatiebron**. In tegenstelling tot
klassieke apps (eenrichtingsmodel operator → reiziger) is Blayse
**tweerichting**: reizigers melden, bevestigen én ontvangen info, samengevoegd
met officiële data en verrijkt door AI.

> REST + SSE API in Node/Express, MongoDB, Redis. Bedient de iOS-app (SwiftUI).

---

## ✨ Wat doet de backend

- **Communitymeldingen** — aanmaken, stemmen (bevestigd / opgelost), moderatie.
- **Vertrouwensscore** (`trustScorerService`) — elke melding wordt gewogen
  (bron, nabijheid, reputatie, toestel); meldingen dichtbij elkaar worden
  gebundeld tot **clusters** met een gecombineerde betrouwbaarheid (gewogen
  gemiddelde `Σt²/Σt`).
- **Blayse AI** (`/api/stib-ai`) — streaming-assistent (SSE) op **Gemini**,
  gevoed met de live context (haltes, favoriete lijnen, meldingen, berekende
  route) en beveiligd tegen verzinsels.
- **Multi-operator** — STIB/MIVB, **SNCB** (iRail + GTFS), **De Lijn** & **TEC**
  (catalogi + officiële verstoringen; realtime per halte voor De Lijn).
- **Routeberekening** (`routeScoringService`) — alternatieven gescoord (duur,
  overstappen, risico, betrouwbaarheid) met omleiding rond verstoorde lijnen.
- **Pushmeldingen** (OneSignal) — clusterwaarschuwingen, pre-trip briefing,
  bedankjes, digest, met fijne voorkeuren (frequentie, stille uren, regels per
  lijn).
- **Apple Wallet** (`/api/wallet`) — genereert een gesigneerde MoBIB-pas (PassKit).
- **Accounts & GDPR** — JWT-auth + Sign in with Apple, export/verwijdering van
  gegevens, gestructureerde logging, rate-limiting.

---

## 🧱 Stack

| Domein | Technologie |
|---|---|
| Runtime | Node.js + Express |
| Database | MongoDB (Mongoose) |
| Cache / realtime | Redis (ioredis), Socket.io |
| AI | Google Gemini (standaard), OpenAI (compatibel) |
| Push | OneSignal (REST) |
| Wallet | passkit-generator (Apple PassKit) |
| Afbeeldingen | Cloudinary |
| Mail | Nodemailer (SMTP) / Resend |
| Beveiliging | helmet, cors, express-rate-limit, express-mongo-sanitize |
| Observability | Winston, Sentry (optioneel) |
| Tests | Jest + supertest + mongodb-memory-server |

---

## 🚀 Aan de slag

> De applicatie staat in de map **`backend/`**.

```bash
cd backend
npm install
cp .env.example .env   # vul daarna de variabelen in (zie hieronder)
npm run dev            # start met nodemon (of `npm start`)
```

De server luistert op `PORT` (standaard **4000**).

### Scripts (`backend/package.json`)
| Script | Rol |
|---|---|
| `npm start` | Productie-start (`node server.js`) |
| `npm run dev` | Dev-start (nodemon) |
| `npm run worker:assistant` | Worker voor assistent-taken (proactieve push) |
| `npm run seed:stib-static` | Importeert de statische STIB-catalogus |
| `npm run seed:sncb` | Importeert de SNCB-stations |
| `npm test` | Tests (Jest, in-band) |

---

## 🔑 Omgevingsvariabelen

De belangrijkste (zie `backend/.env.example` voor de volledige lijst):

**Kern**
- `MONGO_URI` — MongoDB-connectie *(vereist)*
- `REDIS_URL` — Redis-connectie
- `JWT_SECRET`, `ACTIVATION_SECRET` — auth / accountactivatie
- `PORT` — HTTP-poort (standaard 4000)
- `CORS_ORIGINS` — toegelaten origins

**AI (Blayse AI)**
- `AI_GATEWAY_URL` (standaard `https://generativelanguage.googleapis.com/v1beta`)
- `AI_MODEL` (standaard `gemini-2.5-flash`)
- `GEMINI_API_KEY` *(of `OPENAI_API_KEY` afhankelijk van de gateway)*

**Pushmeldingen (OneSignal)**
- `ONESIGNAL_APP_ID`
- `ONESIGNAL_REST_API_KEY` *(legacy → `Basic`-schema, v2 `os_v2_…` → `Key`; automatisch gedetecteerd)*

**Vervoer / kaarten**
- `GOOGLE_API_KEY` — geocoding + directions
- `BELGIAN_MOBILITY_API_BASE_URL`, `BELGIAN_MOBILITY_API_KEY` — realtime STIB / TEC
- `DELIJN_API_KEY` — realtime De Lijn (Kernel API)

**Apple Wallet** *(optioneel — MoBIB-pas)*
- `WALLET_PASS_TYPE_ID`, `WALLET_TEAM_ID`
- `WALLET_SIGNER_CERT_PATH`, `WALLET_SIGNER_KEY_PATH`, `WALLET_SIGNER_KEY_PASS`, `WALLET_WWDR_PATH`

**Sign in with Apple** — `APPLE_TEAM_ID`, `APPLE_BUNDLE_ID`, `APPLE_SIGN_IN_AUDIENCE`
**Afbeeldingen** — `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`
**Mail** — `SMTP_HOST`, `SMTP_PORT`, `SMTP_MAIL`, `SMTP_PASSWORD` *(of `RESEND_API_KEY`)*
**GDPR / privacy** — `SIGNALEMENT_PRIVACY_SALT`, `SIGNALEMENT_TTL_DAYS`, `PRIVACY_CONTACT_EMAIL`
**Achtergrondtaken** — `COMMUNITY_JOBS_ENABLED`, `COMMUNITY_*_INTERVAL_MS`, `PRE_TRIP_*`, `MERCIS_*`, `STIB_OFFICIAL_SEED_*`

---

## 🌐 API-overzicht

| Prefix | Domein |
|---|---|
| `/api/utilisateurs` | Accounts, auth, favorieten, push-tokens, `POST /test-push` |
| `/api/signalements` | Communitymeldingen (aanmaken / stemmen) |
| `/api/clusters` | Clusters van verstoringen + bevestigingen |
| `/api/arrets` | STIB-haltes (nabijheid, zoeken) |
| `/api/lignes` | STIB-lijnen |
| `/api/stib` · `/api/lines/:line/realtime` | STIB realtime |
| `/api/sncb` | SNCB-stations (theoretische dienstregeling + realtime iRail) |
| `/api/operators/:op` | De Lijn / TEC (haltes, lijnen, verstoringen, realtime) |
| `/api/transport` | Routeberekening + aanbevelingen |
| `/api/stib-ai` | Blayse AI (streaming chat, SSE) |
| `/api/assistant` | Pre-trip / proactieve push |
| `/api/wallet` | Apple Wallet-pas genereren (MoBIB) |
| `/api/geocode` | Adressen geocoderen |
| `/admin/moderation` | Moderatiewachtrij (admin) |

---

## 🗂️ Databronnen

Blayse **fuseert** officiële data + community + AI tot één betrouwbaar beeld:

| Bron | Wat | Hoe |
|---|---|---|
| **STIB/MIVB** | Haltes, lijnen, verstoringen, doorkomsten | Open data (statische catalogus) + Belgian Mobility (realtime/officieel) |
| **SNCB/NMBS** | Stations, dienstregeling, storingen | iRail (realtime + storingen) + ingebedde GTFS-dienstregeling |
| **De Lijn** | Haltes, realtime doorkomsten, omleidingen | Kernel Open Data API (per halte) + ingebedde catalogus |
| **TEC** | Lijnen, verstoringen | GTFS-RT via Belgian Mobility + ingebedde lijncatalogus |
| **Community** | Meldingen van reizigers | De app zelf — *het tweerichtingsverschil* |
| **Google** | Geocoding + directions | Adressen opzoeken + fallback-routes |

De statische catalogi (haltes/lijnen) staan in `backend/data/` en worden
geseed via de `seed:*`-scripts; de realtime data wordt live opgehaald en
in-memory gecachet om de externe API's te ontlasten.

---

## 🤖 Hoe AI gebruikt wordt

AI is een **integratie**, geen black box die alles verzint — de logica bouwt de
feiten op, de AI verwoordt ze.

- **Blayse AI** (`/api/stib-ai`) draait op **Google Gemini** (`gemini-2.5-flash`,
  met fallback `gemini-1.5-flash` bij overbelasting).
- **Grounded (RAG-aanpak):** vóór elke vraag bouwt de backend een
  **contextbericht** (nabije haltes, favoriete lijnen, actieve meldingen, en de
  **berekende route** — gemarkeerd als *"bron van waarheid"*). Een strikte
  **systeemprompt** verbiedt de AI iets te citeren dat niet in die context staat
  → geen verzonnen lijnen of haltes.
- **Streaming (SSE):** het antwoord komt woord per woord binnen → directe respons.
- **Tweetalig:** de app stuurt `lang` mee; antwoorden én foutmeldingen komen in
  FR / NL / EN terug.
- **AI-samenvattingen van verstoringen** (`perturbationSummaryService`): regels +
  optioneel OpenAI produceren een leesbaar *wat / waarom / hoelang / wat nu*,
  in FR én NL.
- **Bestemming-extractie** uit vrije tekst: snelle regex client-side, met
  AI-fallback voor exotische formuleringen.

> Kort: de AI **duidt** de échte data die Blayse al heeft — ze vervangt ze niet.

---

## ⚙️ Achtergrondtaken

Gestart bij opstart wanneer `COMMUNITY_JOBS_ENABLED` actief is:
- **Clustering** van recente meldingen.
- **Verval / archivering** van opgeloste verstoringen.
- **Pre-trip briefing** (15 min vóór het gebruikelijke vertrek).
- **Bedankjes** (wanneer een melding andere reizigers heeft geholpen).
- **Officiële STIB-seed** (synchronisatie van officiële verstoringen).

De assistent-worker kan apart draaien: `npm run worker:assistant`.

---

## 🗂️ Structuur

```
backend/
├── server.js            # entry point (DB-connectie + listen)
├── app.js               # Express-app + routes mounten
├── routes/              # endpoint-definities
├── controllers/         # request-logica
├── services/            # businesslogica (trust, clustering, AI, push, wallet…)
├── models/              # Mongoose-schema's
├── middlewares/         # auth, ownership, validatie
├── config/              # db, redis, mail, openai
├── workers/             # taken buiten requests (assistent)
├── scripts/             # catalogi seeden, load test, admin
└── data/                # ingebedde catalogi (De Lijn/TEC haltes & lijnen…)
```

---

## 🧪 Tests

```bash
cd backend
npm test
```
Jest + in-memory database (`mongodb-memory-server`), zonder externe afhankelijkheden.

---

## ☁️ Deployment

Gehost op **Render** (root van de service = `backend/`, start = `node server.js`).
Alle bovenstaande omgevingsvariabelen worden aan de Render-kant geconfigureerd.
Vergeet niet **opnieuw te deployen** na een push om wijzigingen toe te passen.

---

## 📱 iOS-app

De client-app (SwiftUI) staat in een aparte repo. Deze backend levert de
volledige API die ze gebruikt (REST + SSE voor Blayse AI).
