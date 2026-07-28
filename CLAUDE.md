# DI-2966 — Project Brief (ground truth)

Google Chrome extension for a sales manager: parse job sites → save leads to Google Sheets with context preserved across sessions, then deepen each lead (description + company website) and classify it (IT / not-IT) via a free LLM. This is the source of truth; every prompt must rely on it rather than restating context.

> NOTE: This brief was updated after a manager meeting (2026-07-22). Focus is now **TechJobs only**; several earlier "What NOT to do" rules were intentionally REVERSED — see that section. Deadline for the current iteration: **Tuesday next week**.

---

## Deployment: LOCAL

The whole server side runs locally on the developer's laptop. There is no remote hosting.

- Backend: NestJS on `http://localhost:3000`
- DB: PostgreSQL in Docker (`docker-compose`), `localhost:5432`
- Google Sheets: writes via a **service account** (not interactive OAuth)
- Extension (MV3): `host_permissions` include `http://localhost:3000/*` and the target sites
- Backend CORS allows the extension origin (`chrome-extension://<id>`, from `EXTENSION_ORIGIN`)

**Consequence for FR-3:** true "context across different PCs" cannot be verified against a localhost backend. Tested locally: DB persistence + context restore after re-login / restart / different browser profile. Cross-PC deferred until hosting exists.

---

## Stack & repository

TypeScript everywhere. Extension: **WXT** (MV3, side panel) + React. Backend: **NestJS + PostgreSQL + Drizzle ORM**. Node LTS.

**Repository layout:** standalone repo (NOT an nx monorepo). Plain multi-package layout — a `backend/` folder (NestJS) and an `extension/` folder (WXT), each with its own `package.json`. Git remote: private GitHub repo.

---

## Auth (implemented)

Login via **Google OIDC through the backend** (provider `google`). The extension never sees IdP credentials — it only holds the backend's own session token (JWT), sent as `Authorization: Bearer` on every request. Backend flow: `/auth/login` → Google consent → `/auth/callback` → validate ID token → upsert into `external_identities` (provider + provider_user_id + email) linked to a `users` row → issue backend token. `/leads` endpoints are guarded; `owner_user_id` is derived from the token.

IdP is abstracted (internal `user_id` + `external_identities`), so Microsoft (Entra) can be added later as another provider without rework (NFR-7). Google creds live in `backend/.env` (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI=http://localhost:3000/auth/callback`).

---

## Shared team base

The model is a **shared team lead base**, not per-user pipelines:

- **Global dedup:** unique on `(source_site, external_job_id)` and unique on `(source_url)` — NOT scoped by owner. One vacancy = one row for everyone.
- **`owner_user_id` = "created_by":** the user who first parsed the lead. In the side panel, show the owner ONLY when the lead was created by someone other than the current user (small "by <name>" label); for own leads, no clutter. In the Google Sheet, the owner column is always populated.
- **Shared visibility:** `GET /leads` returns ALL leads. All authenticated users see everything. Status is shared per lead.
- **Timezone:** timestamps are stored as UTC in Postgres, but displayed in **Europe/Kyiv** (human-readable) in both the side panel and the Google Sheet.

---

## Parsing focus & mode

- **Primary site: Techjobs.ca.** DevITjobs is **PAUSED** (virtualized list renders only ~18 cards at a time, and it has no publication dates). Don't work on DevITjobs in this iteration.
- **Batch list parse:** one click parses all job cards on the current list page and returns an array. Current tab only, on manual click, at human pace.

---

## Current iteration scope (from manager meeting, TechJobs)

Priority order (A → C are the target; D only if time permits before the Tuesday deadline):

### A. Publication date
- Parse the "Posted M/D/YYYY" value from each Techjobs card into a real field `published_at` (the date the vacancy was posted — distinct from `scraped_at`).
- `published_at` is the **first column** in the Google Sheet.
- Dedup by `external_job_id` already handles reposts (confirmed working).

### B. Auto-deepen (description + company website)
- After the list parse, automatically visit each NEW vacancy's detail page, extract the full **description** text and the **company website** link, and store them (`description`, `company_website`).
- "Auto by all": one click → the system walks all newly parsed leads itself (the manager does not click each lead).
- **Human pace, mandatory:** visit detail pages sequentially with delays — never in parallel or instantly (anti-ban). This is a controlled trade-off; keep volume low by only deepening NEW leads.

### C. Gemini IT-filter
- Send title + description to a **free** Gemini API (Google AI Studio key, in `backend/.env`).
- Broad classification question: "does this posting belong to the IT sphere / could this IT work be done remotely?" Start with the IT filter only — **skip the Remote filter for now**.
- Store the result in an `is_it` field: `it | not_it | unprocessed` (default `unprocessed` until classified). Add it as a column (IT / not-IT) in the Sheet.
- **Do NOT delete** non-IT leads — only flag them.
- **Rate-limit aware:** the free tier has per-minute/day limits. Process sequentially with pauses; on limit/error, do NOT crash — mark the lead `unprocessed` and allow re-running later.

### D. Incremental multi-page by date (DEPRIORITIZED — only if time allows)
- Parse from the latest stored `published_at` up to today, walking pages via the **URL page param** (`?page=N`) — NO Selenium, NO simulated clicks.
- Stop once a page's vacancies are older than the last stored date.
- Manual trigger for now. If the deadline is tight, this is the piece we drop.

**Out of scope (unchanged):** contact enrichment (Apollo/Hunter/PDL) — company name + website only; contacts are looked up manually in LinkedIn afterwards. Also out: HubSpot, "chats".

---

## Google Sheet columns (manager's order)

`published_at` (first) · `external_job_id` · `is_it` (IT / not-IT) · short description · `company_website` · plus existing fields (title, company, location, source_url, status, owner, scraped_at Kyiv, created_at Kyiv). Keep a single source of truth for column order (one array used for both header and rows) so columns never drift.

---

## Data model (Drizzle → Postgres)

- `users(id, email, display_name, created_at)`
- `external_identities(id, user_id→users, provider, provider_user_id, email, created_at)`
- `job_leads(id, owner_user_id→users [= created_by], source_site, source_url, external_job_id, company, company_website, job_title, location, description, salary, tech_stack, apply_url, ats, published_at, is_it, contact_name, contact_email, contact_phone, status, snapshot(jsonb), scraped_at, created_at, updated_at)`
- `status` — enum `new | in_progress | done` (default `new`). Ukrainian UI labels («новий», «опрацьовується», «опрацьований») only; DB/API use English values.
- `is_it` — enum `it | not_it | unprocessed` (default `unprocessed`).
- `published_at` — the vacancy's posted date (parsed from the card).
- **Global dedup indexes:** unique `(source_site, external_job_id)`, unique `(source_url)`.

---

## Parser spec (Techjobs.ca)

### List page (works)
- card: `a[href^="/job/"]`
- `external_job_id`: last path segment (UUID); `source_url`: `https://www.techjobs.ca` + href
- `job_title`: `h3` inside the card
- `location`: 1st `span.text-sm.text-gray-700`
- `published_at`: parse the "Posted M/D/YYYY" text on the card
- into `snapshot`: employment type, seniority
- `company`, `salary`, `description`, `apply_url`, `ats`, `company_website`, contact_*: NOT on the list → filled by deepening (B) or left empty

### Detail page (deepening, implemented)
- No DOM scraping needed: the initial (server-rendered) HTML embeds a clean JSON-LD block
  (`script[type="application/ld+json"]`, `@type: "JobPosting"`) — confirmed against a live
  page and `spikes/techjobs_detail.html`. Fetched as plain HTML text (no tab, no JS
  execution needed) and parsed via regex + `JSON.parse` (works in any extension context,
  including a background service worker with no `document`).
- `description` ← `JobPosting.description` (full text).
- `company` ← `JobPosting.hiringOrganization.name` (backfills the list page's blank `company`).
- `company_website` ← `JobPosting.hiringOrganization.sameAs`.
- `published_at` backfill ← `JobPosting.datePosted` (ISO), only applied when the list card's
  `published_at` was empty — never overwrites a date the list already gave us.
- Caveat: `hiringOrganization` is sometimes the reposting board, not the true employer (the
  real company may only be in the description). Fine for MVP — `sameAs` is stored as-is.

---

## What NOT to do (critical) — REVISED

Reversals from the earlier brief (intentional, per the manager meeting):
- **REVERSED — deepening:** we now DO visit each vacancy's detail page to extract description + company website, automatically for all new leads — but at **human pace** (sequential, with delays), never parallel/instant.
- **REVERSED — external API:** we now DO call a free Gemini API for IT-classification. Must be rate-limit-aware and never crash on limits.
- **REVERSED — multi-page:** paging via the URL `?page=N` param is allowed (deprioritized). Still **NO Selenium / no simulated clicks**.

Still forbidden:
- NO contact enrichment (Apollo/Hunter/PDL); NO scraping contact emails/phones. Company name + website only; contacts via LinkedIn manually.
- NO HubSpot. NO "chats".
- The core stays destination-agnostic (only via the `Destination` interface).
- `status` and `is_it` are server-validated enums, never free strings.
- No secrets / IdP / API keys in the extension code (backend only, from `.env`).
- Do NOT delete non-IT leads — only flag `is_it`.
- Keep DevITjobs paused; don't touch its parser this iteration.

---

## API

- `GET /auth/login` · `GET /auth/callback` · `GET /me` · `POST /auth/logout`
- `GET /leads?status=&site=` (returns ALL leads) · `POST /leads` (single or array; global dedup → update-on-match; DB write always; destination push separate) · `PATCH /leads/:id` (status) · `DELETE /leads/:id`
- Error shape: `{ "error": { "code": "...", "message": "..." } }`. `401` → re-login.

---

## Destination adapter

```
interface Destination { save(record: JobLead): Promise<SaveResult> }
type SaveResult = { status: "created"|"updated"|"failed", externalRef?: string, error?: {code,message} }
```
v1: `SheetsDestination` (service account; find row by `external_job_id`/`source_url`, insert or update; single source of truth for column order; Kyiv-formatted times). The core does NOT know which destination is active.

---

## Non-functional (condensed)

NFR-2 processing basis + delete on request · NFR-3 data goes only to backend, Sheets, and Gemini (public vacancy text only) · NFR-4/5 human pace, only on manager action (applies to deepening too) · NFR-6 IdP/API creds outside the client · NFR-7 user not tied to an IdP · NFR-8 server-side enum validation (status, is_it) · NFR-9 backend = source of truth, `chrome.storage` only cache/token · NFR-10 last-write-wins · NFR-12/13 no silent failures (incl. Gemini rate limits → mark unprocessed) · NFR-14 parser adapters isolated.

---

## Phase plan

Done: 0 parser spike · 1 extension skeleton · 2 backend skeleton · 3 wire-up · 4 Sheets adapter · 5 Google auth. Plus: shared team base, global dedup, owner visibility, Kyiv time.
Paused: 6 DevITjobs.

Current iteration (deadline Tuesday), in priority order:
- **A** — `published_at` field + first Sheet column.
- **B** — auto-deepen description + company website from detail pages (human pace).
- **C** — Gemini IT-filter → `is_it` column.
- **D** — (if time) incremental multi-page by date via URL param.
- **7** — errors + DoD.

---

## Decision log

side panel · thin client + backend · Drizzle · IdP abstraction (Google implemented, Microsoft later) · destination adapter (Sheets) · dedup GLOBAL in the DB (source_url + external_job_id) · owner = created_by, shown only for others in the panel, always in the Sheet · shared visibility (all users see all leads) · status enum + dropdown, shared per lead · UTC in DB, Kyiv on display · snapshot in the DB, flat fields in Sheets · **focus TechJobs, DevITjobs paused** · **deepen description + company website (auto, human pace)** · **Gemini free API for IT-classification (flag, don't delete)** · **contact enrichment stays out — LinkedIn manual** · multi-page via URL param deprioritized.