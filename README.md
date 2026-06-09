# Blayse Backend

Backend van Blayse: een Brusselse mobiliteitsapp die reizigers omvormt tot een
realtime informatiebron. In tegenstelling tot klassieke apps
(eenrichtingsmodel, van operator naar reiziger) is Blayse tweerichting:
reizigers melden, bevestigen én ontvangen info, samengevoegd met officiële data
en verrijkt door AI.

REST + SSE API in Node/Express, MongoDB, Redis. Bedient de iOS-app (SwiftUI).

## Wat doet de backend

- **Communitymeldingen**: aanmaken, stemmen (bevestigd / opgelost), moderatie.
- **Vertrouwensscore** (`trustScorerService`): elke melding wordt gewogen (bron,
  nabijheid, reputatie, toestel); meldingen dichtbij elkaar worden gebundeld tot
  **clusters** met een gecombineerde betrouwbaarheid (gewogen gemiddelde Σt²/Σt).
- **Blayse AI** (`/api/stib-ai`): streaming-assistent (SSE) op Gemini, gevoed met
  de live context en beveiligd tegen verzinsels.
- **Multi-operator**: STIB/MIVB, SNCB (iRail + GTFS), De Lijn en TEC.
- **Routeberekening** (`routeScoringService`): alternatieven gescoord (duur,
  overstappen, risico, betrouwbaarheid) met omleiding rond verstoorde lijnen.
- **Pushmeldingen** (OneSignal): clusterwaarschuwingen, pre-trip briefing,
  bedankjes, digest, met fijne voorkeuren (frequentie, stille uren, regels per lijn).
- **Apple Wallet** (`/api/wallet`): genereert een gesigneerde MoBIB-pas (PassKit).
- **Accounts en GDPR**: JWT-auth + Sign in with Apple, export en verwijdering van
  gegevens, gestructureerde logging, rate-limiting.

## Stack

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

## Aan de slag

De applicatie staat in de map `backend/`.

```bash
cd backend
npm install
cp .env.example .env   # vul daarna de variabelen in
npm run dev            # start met nodemon (of npm start)
```

De server luistert op `PORT` (standaard 4000).

| Script | Rol |
|---|---|
| `npm start` | Productie-start (`node server.js`) |
| `npm run dev` | Dev-start (nodemon) |
| `npm run worker:assistant` | Worker voor assistent-taken (proactieve push) |
| `npm run seed:stib-static` | Importeert de statische STIB-catalogus |
| `npm run seed:sncb` | Importeert de SNCB-stations |
| `npm test` | Tests (Jest, in-band) |

## API-overzicht

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

## Databronnen

Blayse fuseert officiële data, community en AI tot één betrouwbaar beeld.

| Bron | Wat | Link |
|---|---|---|
| STIB/MIVB | Haltes, lijnen, verstoringen, doorkomsten | [opendata.stib-mivb.be](https://opendata.stib-mivb.be) |
| SNCB/NMBS (iRail) | Stations, realtime, storingen | [docs.irail.be](https://docs.irail.be) |
| De Lijn | Haltes, realtime doorkomsten, omleidingen | [data.delijn.be](https://data.delijn.be) |
| TEC | Lijnen, verstoringen | [opendata.tec-wl.be](https://opendata.tec-wl.be) |
| Google Maps Platform | Geocoding, directions | [developers.google.com/maps](https://developers.google.com/maps) |
| Community | Meldingen van reizigers (de app zelf) | n.v.t. |

De statische catalogi (haltes/lijnen) staan in `backend/data/` en worden geseed
via de `seed:*`-scripts; de realtime data wordt live opgehaald en in-memory
gecachet om de externe API's te ontlasten.

## Hoe AI gebruikt wordt

AI is een integratie, geen black box die alles verzint: de logica bouwt de
feiten op, de AI verwoordt ze.

### In de app

- Blayse AI (`/api/stib-ai`) draait op Google Gemini (`gemini-2.5-flash`, met
  fallback `gemini-1.5-flash` bij overbelasting).
- Grounded (RAG-aanpak): vóór elke vraag bouwt de backend een contextbericht
  (nabije haltes, favoriete lijnen, actieve meldingen, en de berekende route,
  gemarkeerd als "bron van waarheid"). Een strikte systeemprompt verbiedt de AI
  iets te citeren dat niet in die context staat, zodat er geen lijnen of haltes
  verzonnen worden.
- Streaming (SSE): het antwoord komt woord per woord binnen.
- Tweetalig: de app stuurt `lang` mee; antwoorden en foutmeldingen komen in
  FR / NL / EN terug.
- AI-samenvattingen van verstoringen (`perturbationSummaryService`): regels plus
  optioneel OpenAI produceren een leesbaar wat / waarom / hoelang / wat nu, in
  FR en NL.
- Bestemming-extractie uit vrije tekst: snelle regex client-side, met AI-fallback
  voor exotische formuleringen.

### Tijdens de ontwikkeling

Deze backend (en de iOS-app) zijn gebouwd met AI-codeerassistenten als pair
programmer:

- **Claude Code** (Anthropic), vooral **Opus 4.6 tot 4.8**: het grootste deel van
  de implementatie, refactoring en debugging.
- **OpenAI Codex (5.5)**: aanvullend voor codegeneratie en review.

De architectuur, de beslissingen en de validatie blijven menselijk; de AI
versnelt het schrijven en het opsporen van bugs.

## Bronnen en referenties

Officiële docs, API's en libraries die hielpen bij het bouwen:

- Express: [expressjs.com](https://expressjs.com)
- Mongoose: [mongoosejs.com](https://mongoosejs.com)
- Socket.io: [socket.io](https://socket.io)
- OneSignal REST API: [documentation.onesignal.com](https://documentation.onesignal.com)
- Google Gemini API: [ai.google.dev](https://ai.google.dev)
- OpenAI API: [platform.openai.com/docs](https://platform.openai.com/docs)
- Apple Wallet / PassKit: [developer.apple.com/wallet](https://developer.apple.com/wallet)
- passkit-generator: [github.com/alexandercerutti/passkit-generator](https://github.com/alexandercerutti/passkit-generator)
- Render (hosting): [render.com](https://render.com)
- AI-tooling: Claude Code ([claude.com/claude-code](https://claude.com/claude-code)), OpenAI Codex ([github.com/openai/codex](https://github.com/openai/codex))

## Achtergrondtaken

Gestart bij opstart wanneer `COMMUNITY_JOBS_ENABLED` actief is:

- Clustering van recente meldingen.
- Verval en archivering van opgeloste verstoringen.
- Pre-trip briefing (15 min vóór het gebruikelijke vertrek).
- Bedankjes (wanneer een melding andere reizigers heeft geholpen).
- Officiële STIB-seed (synchronisatie van officiële verstoringen).

De assistent-worker kan apart draaien: `npm run worker:assistant`.

## Structuur

```
backend/
├── server.js            # entry point (DB-connectie + listen)
├── app.js               # Express-app + routes mounten
├── routes/              # endpoint-definities
├── controllers/         # request-logica
├── services/            # businesslogica (trust, clustering, AI, push, wallet)
├── models/              # Mongoose-schema's
├── middlewares/         # auth, ownership, validatie
├── config/              # db, redis, mail, openai
├── workers/             # taken buiten requests (assistent)
├── scripts/             # catalogi seeden, load test, admin
└── data/                # ingebedde catalogi (De Lijn/TEC haltes en lijnen)
```

## Tests

```bash
cd backend
npm test
```

Jest + in-memory database (`mongodb-memory-server`), zonder externe afhankelijkheden.

## Deployment

Gehost op Render (root van de service = `backend/`, start = `node server.js`).
Alle omgevingsvariabelen (zie `backend/.env.example`) worden aan de Render-kant
geconfigureerd. Vergeet niet opnieuw te deployen na een push om wijzigingen toe
te passen.

## iOS-app

De client-app (SwiftUI) staat in een aparte repo. Deze backend levert de
volledige API die ze gebruikt (REST + SSE voor Blayse AI).
