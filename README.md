# Blayse — Backend

Backend de **Blayse** (anciennement *StibAlert*) : une app de mobilité bruxelloise
qui transforme les voyageurs en **source d'information temps réel**. Contrairement
aux apps classiques (modèle à sens unique opérateur → voyageur), Blayse est
**bidirectionnel** : les voyageurs signalent, confirment et reçoivent l'info,
fusionnée avec les données officielles et enrichie par l'IA.

> API REST + SSE en Node/Express, MongoDB, Redis. Sert l'app iOS (SwiftUI).

---

## ✨ Ce que fait le backend

- **Signalements communautaires** — création, vote (confirmé / résolu), modération.
- **Score de confiance** (`trustScorerService`) — chaque signalement est pondéré
  (source, proximité, réputation, appareil) ; les signalements proches sont
  agrégés en **clusters** avec une confiance combinée (moyenne pondérée `Σt²/Σt`).
- **Blayse AI** (`/api/stib-ai`) — assistant en streaming (SSE) sur **Gemini**,
  nourri du contexte live (arrêts, lignes favorites, signalements, trajet calculé)
  et bridé contre l'hallucination.
- **Multi-opérateur** — STIB/MIVB, **SNCB** (iRail + GTFS), **De Lijn** & **TEC**
  (catalogues + perturbations officielles, temps réel par arrêt pour De Lijn).
- **Calcul d'itinéraires** (`routeScoringService`) — alternatives scorées (durée,
  correspondances, risque, fiabilité) avec re-routage autour des lignes perturbées.
- **Notifications push** (OneSignal) — alertes cluster, brief pré-trajet, mercis,
  digest, avec préférences fines (fréquence, heures silencieuses, règles par ligne).
- **Apple Wallet** (`/api/wallet`) — génération d'un pass MoBIB signé (PassKit).
- **Comptes & RGPD** — auth JWT + Sign in with Apple, export/suppression de données,
  logs structurés, rate-limiting.

---

## 🧱 Stack

| Domaine | Techno |
|---|---|
| Runtime | Node.js + Express |
| Base de données | MongoDB (Mongoose) |
| Cache / temps réel | Redis (ioredis), Socket.io |
| IA | Google Gemini (défaut), OpenAI (compat.) |
| Push | OneSignal (REST) |
| Wallet | passkit-generator (Apple PassKit) |
| Images | Cloudinary |
| Mail | Nodemailer (SMTP) / Resend |
| Sécurité | helmet, cors, express-rate-limit, express-mongo-sanitize |
| Observabilité | Winston, Sentry (optionnel) |
| Tests | Jest + supertest + mongodb-memory-server |

---

## 🚀 Démarrage

> L'application vit dans le dossier **`backend/`**.

```bash
cd backend
npm install
cp .env.example .env   # puis remplis les variables (voir ci-dessous)
npm run dev            # démarrage avec nodemon (ou `npm start`)
```

Le serveur écoute sur `PORT` (défaut **4000**).

### Scripts (`backend/package.json`)
| Script | Rôle |
|---|---|
| `npm start` | Démarrage production (`node server.js`) |
| `npm run dev` | Démarrage dev (nodemon) |
| `npm run worker:assistant` | Worker des jobs assistant (push proactives) |
| `npm run seed:stib-static` | Importe le catalogue statique STIB |
| `npm run seed:sncb` | Importe les gares SNCB |
| `npm test` | Tests (Jest, in-band) |

---

## 🔑 Variables d'environnement

Les essentielles (voir `backend/.env.example` pour la liste complète) :

**Cœur**
- `MONGO_URI` — connexion MongoDB *(requis)*
- `REDIS_URL` — connexion Redis
- `JWT_SECRET`, `ACTIVATION_SECRET` — auth / activation de compte
- `PORT` — port HTTP (défaut 4000)
- `CORS_ORIGINS` — origines autorisées

**IA (Blayse AI)**
- `AI_GATEWAY_URL` (défaut `https://generativelanguage.googleapis.com/v1beta`)
- `AI_MODEL` (défaut `gemini-2.5-flash`)
- `GEMINI_API_KEY` *(ou `OPENAI_API_KEY` selon le gateway)*

**Notifications push (OneSignal)**
- `ONESIGNAL_APP_ID`
- `ONESIGNAL_REST_API_KEY` *(legacy → schéma `Basic`, v2 `os_v2_…` → `Key`, géré automatiquement)*

**Transport / cartes**
- `GOOGLE_API_KEY` — géocodage + directions
- `BELGIAN_MOBILITY_API_BASE_URL`, `BELGIAN_MOBILITY_API_KEY` — temps réel STIB / TEC
- `DELIJN_API_KEY` — temps réel De Lijn (Kernel API)

**Apple Wallet** *(optionnel — pass MoBIB)*
- `WALLET_PASS_TYPE_ID`, `WALLET_TEAM_ID`
- `WALLET_SIGNER_CERT_PATH`, `WALLET_SIGNER_KEY_PATH`, `WALLET_SIGNER_KEY_PASS`, `WALLET_WWDR_PATH`

**Apple Sign-In** — `APPLE_TEAM_ID`, `APPLE_BUNDLE_ID`, `APPLE_SIGN_IN_AUDIENCE`
**Images** — `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`
**Mail** — `SMTP_HOST`, `SMTP_PORT`, `SMTP_MAIL`, `SMTP_PASSWORD` *(ou `RESEND_API_KEY`)*
**RGPD / vie privée** — `SIGNALEMENT_PRIVACY_SALT`, `SIGNALEMENT_TTL_DAYS`, `PRIVACY_CONTACT_EMAIL`
**Jobs communautaires** — `COMMUNITY_JOBS_ENABLED`, `COMMUNITY_*_INTERVAL_MS`, `PRE_TRIP_*`, `MERCIS_*`, `STIB_OFFICIAL_SEED_*`

---

## 🌐 Aperçu de l'API

| Préfixe | Domaine |
|---|---|
| `/api/utilisateurs` | Comptes, auth, favoris, tokens push, `POST /test-push` |
| `/api/signalements` | Signalements communautaires (créer / voter) |
| `/api/clusters` | Clusters de perturbations + confirmations |
| `/api/arrets` | Arrêts STIB (proximité, recherche) |
| `/api/lignes` | Lignes STIB |
| `/api/stib` · `/api/lines/:line/realtime` | Temps réel STIB |
| `/api/sncb` | Gares SNCB (horaires théoriques + temps réel iRail) |
| `/api/operators/:op` | De Lijn / TEC (arrêts, lignes, perturbations, temps réel) |
| `/api/transport` | Calcul d'itinéraires + recommandations |
| `/api/stib-ai` | Blayse AI (chat streaming SSE) |
| `/api/assistant` | Push pré-trajet / proactives |
| `/api/wallet` | Génération du pass Apple Wallet (MoBIB) |
| `/api/geocode` | Géocodage d'adresses |
| `/admin/moderation` | File de modération (admin) |

---

## ⚙️ Jobs en arrière-plan

Lancés au démarrage si `COMMUNITY_JOBS_ENABLED` est actif :
- **Clustering** des signalements récents.
- **Expiration / archivage** des perturbations résolues.
- **Brief pré-trajet** (15 min avant le départ habituel).
- **Mercis** (quand un signalement a aidé d'autres voyageurs).
- **Seed officiel STIB** (synchro des perturbations officielles).

Le worker assistant peut tourner séparément : `npm run worker:assistant`.

---

## 🗂️ Structure

```
backend/
├── server.js            # point d'entrée (connexion DB + listen)
├── app.js               # app Express + montage des routes
├── routes/              # définitions des endpoints
├── controllers/         # logique des requêtes
├── services/            # logique métier (trust, clustering, IA, push, wallet…)
├── models/              # schémas Mongoose
├── middlewares/         # auth, ownership, validation
├── config/              # db, redis, mail, openai
├── workers/             # jobs hors-requête (assistant)
├── scripts/             # seed catalogues, load test, admin
└── data/                # catalogues embarqués (De Lijn/TEC stops & lignes…)
```

---

## 🧪 Tests

```bash
cd backend
npm test
```
Jest + base en mémoire (`mongodb-memory-server`), sans dépendances externes.

---

## ☁️ Déploiement

Déployé sur **Render** (root du service = `backend/`, start = `node server.js`).
Toutes les variables d'environnement ci-dessus sont à configurer côté Render.
Penser à **redéployer** après un push pour appliquer les changements.

---

## 📱 App iOS

L'app cliente (SwiftUI) vit dans un repo séparé. Ce backend expose toute l'API
qu'elle consomme (REST + SSE pour Blayse AI).
