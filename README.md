# Sales Manager Chrome Extension

A Chrome extension + backend that parses job listings, enriches them (Apollo/OpenAI), and gives a sales manager a dashboard of leads ready for outreach. See `CLAUDE.md` for the full project brief (data model, API, parser spec, scope, decision log) and `DEVOPS_HANDOFF.md` for a deeper technical audit of the current state (architecture, external dependencies, operational fragility) — this README is the practical "how to actually run/deploy this" doc.

## Layout

```
backend/     NestJS + Drizzle + Postgres API
extension/   WXT (MV3) Chrome extension, side panel + React, dev/prod build variants
```

---

## Part 1 — Running everything locally (development)

Everything below sets up the whole stack on your own machine, exactly as it's been developed.

### Prerequisites

- Node.js LTS
- Docker Desktop (for Postgres)
- A Google Cloud OAuth client (for login) — see "Google OAuth setup" below if you don't have one yet
- Optional: Apollo.io, OpenAI, Gemini, and/or Anthropic API keys, depending on which features you want to exercise (see `.env.example` for exactly which feature needs which key)

### 1. Install dependencies

```
npm install
```

(npm workspaces install both `backend/` and `extension/`.)

### 2. Start Postgres

```
npm run db:up
```

Brings up Postgres in Docker on `localhost:5432` (see `backend/docker-compose.yml`). This container is Postgres only — it does not build or run the NestJS app itself.

### 3. Configure the backend

```
cp backend/.env.example backend/.env
```

Edit `backend/.env` — see the comments in `.env.example` for what each variable does and where to get it. At minimum for local dev you need `DATABASE_URL` (defaults already match `docker-compose.yml`), `JWT_SECRET`, and a Google OAuth client (`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`GOOGLE_REDIRECT_URI`) — login is real Google OIDC, not a stub. `DEV_USER_ID` is an optional legacy leftover from before that existed (`backend/src/main.ts` only runs its stub-owner upsert if this is set — boot doesn't require it); you can leave it unset. Everything else (Apollo/OpenAI/Gemini/Anthropic keys, Google Sheets) is optional too, and only needed to exercise that specific feature — the backend starts fine without them, that feature just won't work until configured.

### 4. Run the database migrations

```
npm run db:migrate
```

Applies every migration under `backend/drizzle/` to your Postgres instance, building the schema from scratch. From the repo root, `npm run db:migrate` is a convenience composite (`npm run db:generate --workspace backend && npm run db:migrate --workspace backend` — see the root `package.json`) meant for exactly this kind of fresh bootstrap, where there's nothing new to generate since the checked-in migrations already match `backend/src/db/schema.ts`.

If you actually **change** `schema.ts` later, don't reuse that same root-level composite — work from `backend/` directly so you get a chance to inspect the generated SQL before applying it:
```
cd backend
npm run db:generate   # produces a new migration file under backend/drizzle/ — inspect it, must be additive-only
npm run db:migrate    # applies it
```

### 5. Start the backend

```
npm run dev:backend
```

Nest starts on `http://localhost:3000` with hot reload. On boot it upserts the `DEV_USER_ID` stub user, if set. **Don't run `npm run build`/`nest build` in another terminal while this is running** — `deleteOutDir: true` means a standalone build wipes `dist/` out from under the live watcher's incremental compiler and crashes it. `npx tsc --noEmit` is safe to run alongside it; a full build is not.

### 6. Run the extension in dev mode

```
npm run dev:extension
```

This always builds in **development mode** (WXT's own dev/prod convention — see "Distributing the extension" in Part 2 for the full mechanism): a stable dev extension ID, and `WXT_BACKEND_URL` from `extension/.env.development` (`http://localhost:3000` by default).

1. Go to `chrome://extensions`
2. Enable "Developer mode"
3. "Load unpacked" → select `extension/.output/chrome-mv3/`. (Dev and prod builds currently share this same output folder — WXT doesn't suffix it per mode in this project's config — so building one after the other overwrites it. That's fine for normal local dev, where you're only ever running one variant at a time; see "Distributing the extension" in Part 2 if you ever need both loaded side by side on one machine.)
4. Set `EXTENSION_ORIGIN=chrome-extension://<the dev ID>` in `backend/.env`, then restart the backend. (The dev build's ID is stable across reloads/rebuilds now — see Part 2 — so you only need to do this once, not after every reload.)

### 7. Try it

1. Open a Techjobs.ca, ITjobs.ca, or Wellfound.com job-list page in a normal Chrome tab.
2. Open the extension's side panel (click the toolbar icon).
3. Click **Parse current list page** (or use the date-range auto-parse for Wellfound) — parses visible job cards and posts them to `POST /leads`.
4. Open `http://localhost:3000/dashboard` (same Google login) to browse, filter, enrich, and export leads.

---

## Part 2 — Deploying to production (DevOps handoff)

This section is for whoever provisions and runs this outside a developer's laptop. Read `DEVOPS_HANDOFF.md` too — it has a deeper audit of known operational gaps (no CI, no tests, no health-check endpoint, no backup mechanism for the database) that aren't repeated in full here.

### What you're deploying

Two independent pieces, no shared infrastructure between them:
1. **Backend** — a NestJS app + Postgres database. This is the only thing that needs server hosting.
2. **Chrome extension** — a static build, distributed directly to the end user (Mariia), not through backend infrastructure. See "Distributing the extension" below.

There is currently **no Dockerfile for the backend app itself** — only `backend/docker-compose.yml`, which provisions Postgres alone. Decide your own deployment method for the Node process (Docker image, PM2, systemd, your platform's standard) — nothing in this repo assumes one.

### Database — no data migration needed

You do not need any data from the development database. You need a **fresh Postgres 16 instance** (`backend/docker-compose.yml` pins `postgres:16-alpine`, if that's a useful reference) and to run the same migration files already checked into this repo:

```
cd backend
npm run db:migrate
```

This builds the full schema (`users`, `external_identities`, `job_leads`) from `backend/drizzle/`'s migration files against whatever `DATABASE_URL` points to. There is no separate "seed data" step and no existing rows need to be copied anywhere.

### Environment variables — what to create, and where each comes from

Copy `backend/.env.example` as your starting point. Every variable is commented there with what it's for; the summary below is what to actually go get before you can bring the backend up for real use, and **it should generally be a fresh, org-owned value — not a personal developer's own key** wherever billing is involved:

| Variable | Required? | Where it comes from |
|---|---|---|
| `PORT` | Yes | Your own choice / platform convention |
| `DATABASE_URL` | Yes | Your own Postgres instance's connection string |
| `DEV_USER_ID` | No — optional legacy stub | Real per-user auth already exists via Google OIDC (see CLAUDE.md); `backend/src/main.ts` only runs the stub-owner upsert if this is set, so it's not required to boot. Leave it unset in production unless you have a specific reason to keep it. |
| `JWT_SECRET` | Yes | Generate fresh: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` — never reuse the development value |
| `EXTENSION_ORIGIN` | Yes | The **production** extension's Chrome ID — see "Distributing the extension" below, this is a fixed, known value now, not something you discover after installing |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` | Yes | A Google Cloud OAuth client — see "Google OAuth setup" below |
| `GEMINI_API_KEY` | Yes (powers the IT/not-IT classifier) | Google AI Studio, free tier |
| `OPENAI_API_KEY` | Yes (powers DM/LPR search's default provider) | platform.openai.com — **org-owned, billing-capable account.** No free tier, and this codebase has no spend cap or budget alerting configured anywhere — factor that into whichever account/card you attach this to. |
| `APOLLO_API_KEY` | Yes (DM/LPR search's Apollo provider, industry data) | developer.apollo.io — free account; note `mixed_people/api_search` is free but `people/bulk_match` consumes paid credits per person found |
| `GOOGLE_SHEETS_SYNC_ENABLED` | No — leave unset/false | Google Sheets sync is disabled by design as of 30.08 (the dashboard replaced it) — only set to `true` if you deliberately want it back, and only then do the two vars below matter |
| `GOOGLE_SA_KEY_PATH` / `SHEET_ID` | No | Only needed if `GOOGLE_SHEETS_SYNC_ENABLED=true` |
| `GEMINI_API_KEY_LPR_TEST` | No | Alternate DM-search provider; this project's own history notes billing/quota issues on this key specifically — not part of the recommended path |
| `ANTHROPIC_API_KEY_LPR_TEST` | No | Alternate DM-search provider; a live test on record cost ~$0.65/lead — don't enable this as a default, it's roughly 5-6x OpenAI's cost |
| `GEMINI_MODEL` | No | Falls back to a hardcoded default if unset |

**Note on industry classification:** an LLM-based "Classify Industry" feature existed but was deliberately disabled on 01.09 (client decision — Apollo's own raw industry field is used directly instead, no AI interpretation). The button is intentionally inert; this is not a bug.

### Google OAuth setup

Login is Google OIDC. Whoever controls the Google Cloud project backing `GOOGLE_CLIENT_ID` needs to add the real deployed backend's callback URL (`https://<your-deployed-backend>/auth/callback`) as an **authorized redirect URI** in that OAuth client's Google Cloud Console settings — this is Google Cloud configuration, not something in this repository, and login will fail with a redirect-mismatch error until it's done.

### Distributing the extension (not published to the Chrome Web Store)

The extension is not going through the Chrome Web Store. It has **separate, independent dev and production builds** (WXT's own env-mode mechanism — `.env.development` / `.env.production` in `extension/`), each with its own permanently stable Chrome extension ID (derived from a dedicated RSA keypair per build, not reassigned on every install):

- **Production build:** `npm run build --workspace extension` (or `npx wxt build` from `extension/`) — uses `extension/.env.production`'s `WXT_BACKEND_URL`. **Before building for real deployment, edit that one line to the actual deployed backend URL** — everything else (manifest key, permissions) is already wired to read from it.
- The production extension's Chrome ID is fixed by its keypair (`extension/keys/prod-key.pem`, gitignored — **back this file up somewhere outside this machine**; losing it means the production extension's ID changes on the next build, breaking the deployed backend's `EXTENSION_ORIGIN` and requiring Mariia to reinstall).
- Dev and production builds currently land in the **same** output folder (`extension/.output/chrome-mv3/` — WXT's default `outDirTemplate` doesn't include a per-mode suffix in this project's config, confirmed by building both modes back to back and inspecting the output). In practice this hasn't mattered because dev and prod are built/loaded at different times on different machines (Nataliia's laptop vs. Mariia's) — but if you ever need both loaded side by side on the same machine, build one, copy that folder aside before building the other, or add an `outDirTemplate` with `{{modeSuffix}}` to `extension/wxt.config.ts` for a permanent fix (WXT supports this natively; not currently configured).
- **Installation, since there's no Web Store listing:** build production (`extension/.output/chrome-mv3/`), get that folder to Mariia, and have her:
  1. Go to `chrome://extensions`
  2. Enable "Developer mode" (top-right toggle)
  3. "Load unpacked" → select the `chrome-mv3` folder
  
  This has no auto-update — a new build means replacing the folder and reloading it manually. If this becomes a long-term daily tool rather than a first version, a Chrome Enterprise `ExtensionInstallForcelist` policy (silent, centrally managed install, no Developer Mode needed) is the standard next step, but requires the target machine to be under Google Workspace / Chrome Browser Cloud Management or a Windows group policy — out of scope for this handoff.

### Known gaps worth knowing before this is trusted with real production traffic

(See `DEVOPS_HANDOFF.md` for the full detail on each.)
- No backup mechanism for the database — losing the Postgres volume loses everything.
- No automated tests, no CI, no linting.
- No health-check endpoint.
- No spend cap on OpenAI usage anywhere in this codebase.
- Soft-deleted leads are permanently purged after `LEAD_RETENTION_DAYS` (30) days by an in-process cron job — this only fires while the Node process stays continuously running; there's no external scheduler behind it.
