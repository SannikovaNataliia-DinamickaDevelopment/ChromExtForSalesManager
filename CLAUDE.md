# DI-2966 — Project Brief (ground truth)

Google Chrome extension for a sales manager: parse job sites → save leads to Google Sheets with context preserved across sessions. This is the **v1** prototype. This file is the source of truth; every prompt must rely on it rather than restating context.

---

## Deployment: LOCAL

The whole server side runs locally on the developer's laptop. There is no remote hosting.

- Backend: NestJS on `http://localhost:3000`
- DB: PostgreSQL in Docker (`docker-compose`), `localhost:5432`
- Google Sheets: writes via a **service account** (not interactive OAuth)
- Extension (MV3): `host_permissions` include `http://localhost:3000/*` and the target sites
- Backend CORS allows the extension origin (`chrome-extension://<id>`)

**Consequence for FR-3:** true "context across different PCs" cannot be verified against a localhost backend. In v1 we test DB persistence + context restore after re-login / restart / different browser profile on the same laptop. Cross-PC is deferred until hosting exists (or a temporary tunnel).

---

## Stack

TypeScript everywhere. Extension: **WXT** (MV3, side panel) + React. Backend: **NestJS + PostgreSQL + Drizzle ORM**. Node LTS.

**Repository layout:** standalone repo (NOT an nx monorepo). Plain multi-package layout — a `backend/` folder (NestJS) and an `extension/` folder (WXT), each with its own `package.json`.

---

## Parsing mode: BATCH (whole list)

One click parses **all job cards on the current list page** and returns an **array** of leads. Current tab only, on manual click. **No auto-scroll, no auto-paging, and NO auto-visiting individual job pages.** "Deepening" a lead (opening its job page to fetch missing fields) is a separate, per-lead manual action — never done in bulk (anti-ban, NFR-4/5).

Per-site field availability differs (see Parser spec): DevITjobs list cards are rich; Techjobs list cards are shallow (company/salary/description are only on the job detail page). For Techjobs, those fields stay **empty** after a list parse — this is expected, not a bug.

---

## v1 Scope

**In:** login (Microsoft or Google — see Auth), batch-parse the current job-list page on the supported site(s), capture `source_url` + `external_job_id` + `snapshot`, dedup, save to Google Sheets, context on the backend. Primary site: Techjobs.ca (DevITjobs in phase 6).

**Out (do not build):** enrichment and paid APIs; auto-fetching emails/phones; auto-visiting job pages to deepen in bulk; HubSpot; "chats"; other sites.

---

## Parser spec (Phase 0 result — real selectors)

Interface: `SiteParser { parseList(document): JobLead[] }`. Each site implements it. Extra card fields not in the schema (employment_type, seniority) go into `snapshot`, not new columns.

### TechjobsListParser (Techjobs.ca — SHALLOW)
- card: `a[href^="/job/"]`
- `external_job_id`: last path segment of href (UUID)
- `source_url`: `https://www.techjobs.ca` + href
- `job_title`: `h3` inside the card
- `location`: 1st `span.text-sm.text-gray-700` in the card (map-pin row)
- into `snapshot`: 2nd such span = employment type (e.g. FULL_TIME), 3rd = seniority; "Posted M/D/YYYY" text
- `company`, `salary`, `description`, `tech_stack`, `apply_url`, `ats`, `contact_*`: NOT on the list → leave empty (only on the detail page)
- Note: Techjobs is Next.js/RSC; parse the DOM, do NOT rely on the `self.__next_f` stream.

### DevitjobsListParser (DevITjobs — RICH, phase 6)
- authoritative posting set: `script[type="application/ld+json"]` → `ItemList.itemListElement[].url`
- card: `a[href^="/jobs/"]` excluding `.../all`
- `external_job_id`: slug (last path segment)
- `source_url`: full https URL (from JSON-LD)
- `job_title`: card title text / `title` attribute
- `company`: card text (also encoded in slug/title after "bij")
- `location`: card text + `title` attribute ("job in <City>")
- `salary`: text "€…" (present on the list)
- `tech_stack`: list items
- `description`, `apply_url`, `ats`, `contact_*`: detail page only

Both IDs (UUID / slug) are stable dedup keys.

---

## Data model (Drizzle → Postgres)

- `users(id, email, display_name, created_at)`
- `external_identities(id, user_id→users, provider, provider_user_id, email, created_at)`
- `job_leads(id, owner_user_id→users, source_site, source_url, external_job_id, company, job_title, location, description, salary, tech_stack, apply_url, ats, contact_name, contact_email, contact_phone, status, snapshot(jsonb), scraped_at, created_at, updated_at)`
- `status` — enum: `new | in_progress | done` (default `new`). Ukrainian labels («новий», «опрацьовується», «опрацьований») live ONLY in the UI; DB/API use English values.
- **Dedup** — GLOBAL, shared across all users (not per-owner): unique on `(source_site, external_job_id)` and unique on `(source_url)`. `owner_user_id` means **created_by** (the user who first parsed the lead) — attribution only, never part of the dedup key and never touched on re-parse/update.
- Per-site: many fields are legitimately empty after a Techjobs list parse (see Parser spec).

---

## API

- `GET /auth/login` · `GET /auth/callback` · `GET /me` · `POST /auth/logout`
- `GET /leads?status=&site=` · `POST /leads` (accepts a **single lead OR an array** for batch) · `PATCH /leads/:id` (status) · `DELETE /leads/:id`
- Error shape: `{ "error": { "code": "...", "message": "..." } }`. `401` → re-login.
- `POST /leads`: dedups each item (update on match, not `409`); DB write **always** happens; destination push is separate. Returns per-item `{ lead, deduplicated, destination:"ok"|"failed" }` (an array for batch).

---

## Destination adapter

```
interface Destination { save(record: JobLead): Promise<SaveResult> }
type SaveResult = { status: "created"|"updated"|"failed", externalRef?: string, error?: {code,message} }
```
v1: `SheetsDestination` (service account; find row by `external_job_id`/`source_url`, insert or update). The core does NOT know which destination is active — only via the interface.

---

## Auth

v1 IdP: **Microsoft (Entra ID)** if the corporate tenant allows app registration; otherwise **Google** for the prototype. The IdP abstraction (internal `user_id` + `external_identities`) makes this swap free — no rework (NFR-7). Login always goes through the backend (OIDC); the extension only ever holds the backend token. Auth is phase 5.

---

## Functional requirements (condensed)

FR-1 login via backend (Microsoft or Google) · FR-2 restore context after login · FR-3 context across browser/PC/after close · FR-4 button active only on supported sites · **FR-5 batch-parse the current list page → returns an array of leads (current tab, on click, no auto-scroll/paging/deepening)** · FR-6 technical fields (URL, job-ID, snapshot, scraped_at, status) · FR-7 human pace · FR-8 dedup by URL/job-ID → update · FR-9 save to Sheets via adapter · FR-10 HubSpot = new adapter without touching the core · FR-11 contact fields not via enrichment · FR-12 status via dropdown (enum), synced.

## Non-functional (condensed)

NFR-1 only visible data · NFR-2 processing basis + delete on request · NFR-3 only backend + Sheets · NFR-4/5 human pace, only on manager action · NFR-6 IdP credentials outside the client · NFR-7 user not tied to an IdP · NFR-8 server-side status validation · NFR-9 backend = source of truth, `chrome.storage` only cache/token · NFR-10 last-write-wins · NFR-11 restore ≤2s typical / ≤5s ceiling · NFR-12/13 no silent failures · NFR-14 parser adapters isolated.

---

## What NOT to do (critical)

- No enrichment / calls to Apollo/Hunter/PDL. Leave contact fields as-is.
- No HubSpot. Google Sheets only.
- No "chats".
- **No auto-scroll / auto-paging / auto-visiting job pages to deepen in bulk.** Parse the current list page only, on click. Deepening is a separate per-lead manual action (not in the batch flow).
- The core does NOT know the concrete destination — only through the `Destination` interface.
- `status` is an enum, validated on the server, never a free string.
- No secrets / IdP credentials in the extension code.
- For Techjobs, do NOT fetch detail pages to fill missing fields during a list parse — leave them empty.

---

## Phase plan

0. **Parser spike — DONE.** Real list selectors captured for Techjobs.ca and DevITjobs (see Parser spec).
1. **Extension skeleton** (side panel + SW + CS), Techjobs.ca batch list parser (real selectors), state in memory.
2. **Backend skeleton** (Drizzle 3 tables, GET/POST /leads with batch + dedup), user stub.
3. **Wire-up**: extension ↔ backend, context from `GET /leads`, statuses via `PATCH`.
4. **Sheets adapter**.
5. **Auth** OIDC (Microsoft or Google); user stub disappears.
6. **Second site** DevITjobs list parser (tests NFR-14).
7. **Errors + DoD**.

The "parse → backend → destination" spine works right after phase 4.

---

## Decision log

side panel · thin client + backend · Drizzle · IdP abstraction (Microsoft or Google for prototype) · destination adapter (Sheets first) · enrichment off · dedup in the DB (URL + job-ID) · status enum + dropdown · last-write-wins · snapshot in the DB, flat fields in Sheets · **batch list parsing; Techjobs list is shallow, deepening is manual per-lead**.

**Shared team lead base (supersedes per-user pipelines):** dedup is GLOBAL — one row per posting across the whole team, not per-owner — unique on `(source_site, external_job_id)` and `(source_url)`. `owner_user_id` is repurposed as **created_by** (who first parsed it): kept and displayed, but no longer scopes dedup or visibility, and is never overwritten when someone else re-parses the same posting. `GET /leads` returns every lead to every authenticated user (no per-user filtering); `status` is one shared value per lead, editable by anyone. Side panel shows an owner badge only when a lead's creator isn't the current user. Timestamps stay stored as UTC in Postgres; `scraped_at`/`created_at` are converted to **Europe/Kyiv** for display, both in the side panel and as formatted columns in the Sheet (Sheet also gained an always-populated `owner` column).