# Sales Manager Chrome Extension (v1 prototype)

See `Claude.md` for the full project brief (data model, API, parser spec, scope).
This README only covers bringing the vertical slice up locally.

Everything runs on your laptop — no remote hosting (see `Claude.md` → Deployment: LOCAL).

## Layout

```
backend/     NestJS + Drizzle + Postgres API (http://localhost:3000)
extension/   WXT (MV3) Chrome extension, side panel + React
spikes/      saved job-list HTML snapshots used for the Phase 0 parser spike
```

## Prerequisites

- Node.js LTS
- Docker Desktop (for Postgres)
- Google Cloud service account with access to a target Google Sheet (for the Sheets destination — optional for phases 1-3, required once you exercise `POST /leads` end-to-end)

## 1. Install dependencies

```
npm install
```

(npm workspaces install both `backend/` and `extension/`.)

## 2. Start Postgres

```
npm run db:up
```

Brings up Postgres in Docker on `localhost:5432` (see `backend/docker-compose.yml`).

## 3. Configure the backend

```
cp backend/.env.example backend/.env
```

Edit `backend/.env`:
- `DATABASE_URL` — defaults match `docker-compose.yml`, no change needed for local Docker.
- `DEV_USER_ID` — any UUID; the backend auto-creates this user on boot (auth is phase 5, this is the stub owner).
- `EXTENSION_ORIGIN` — set once you've loaded the unpacked extension in Chrome and have its ID (`chrome://extensions`), e.g. `chrome-extension://abcdefghijklmnop...`.
- `GOOGLE_SA_KEY_PATH` / `SHEET_ID` — path to your service account JSON key and the target spreadsheet ID. The backend still starts without these; `POST /leads` will just return `destination: "failed"` for each item until they're set.

## 4. Run the database migrations

```
npm run db:migrate
```

(Generates SQL from `backend/src/db/schema.ts` into `backend/drizzle/` and applies it. Re-run after any schema change.)

## 5. Start the backend

```
npm run dev:backend
```

Nest starts on `http://localhost:3000` with hot reload. On boot it upserts the `DEV_USER_ID` stub user.

## 6. Run the extension in dev mode

```
npm run dev:extension
```

WXT opens a dev-mode Chrome instance with the extension pre-loaded, or generates `extension/.output/chrome-mv3-dev/` for manual loading:

1. Go to `chrome://extensions`
2. Enable "Developer mode"
3. "Load unpacked" → select `extension/.output/chrome-mv3-dev/` (or `chrome-mv3/` for a production build via `npm run build --workspace extension`)
4. Copy the extension ID and set it as `EXTENSION_ORIGIN` in `backend/.env`, then restart the backend.

## 7. Try it

1. Open a Techjobs.ca job-list page in a normal Chrome tab.
2. Open the extension's side panel (click the toolbar icon).
3. Click **Parse current list page** — this batch-parses every visible card on that one page (no auto-scroll/paging, no visiting individual job pages — see `Claude.md` → Parsing mode) and posts the array to `POST /leads`.
4. The lead list below refreshes from `GET /leads`; use the status dropdown (Ukrainian labels) to move a lead through `новий → опрацьовується → опрацьований`, which `PATCH`es the English enum value to the backend.

## What's implemented vs. stubbed

See the end of the scaffolding session summary for the phase 1-4 checklist. In short:
- Real: Techjobs list parsing, batch POST with dedup, Postgres persistence, status updates, Sheets destination adapter (needs your own service account + sheet to actually write).
- Stubbed: auth (fixed `DEV_USER_ID`, phase 5), DevITjobs parser (phase 6), any UI polish beyond a functional list.
