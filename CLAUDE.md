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

- **Primary site: Techjobs.ca.** **ITjobs.ca added as a second source** (same template, `source_site: "itjobs"` — see Parser spec). **Wellfound.com added as a third source** (`source_site: "wellfound"`, own selectors, DataDome-blocked — deepens via a real tab, not a fetch; Gemini stays OFF for it — see Parser spec). DevITjobs is **PAUSED** (virtualized list renders only ~18 cards at a time, and it has no publication dates). Don't work on DevITjobs in this iteration.
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
- `job_leads(id, owner_user_id→users [= created_by], source_site, source_url, external_job_id, company, company_website, job_title, location, description, salary, tech_stack, apply_url, ats, published_at, is_it, contact_name, contact_email, contact_phone, hiring_contact_status, hiring_contact_name, hiring_contact_role, hiring_contact_location, company_linkedin_status, company_linkedin_urls, status, snapshot(jsonb), scraped_at, created_at, updated_at)`
- `status` — enum `new | in_progress | done` (default `new`). Ukrainian UI labels («новий», «опрацьовується», «опрацьований») only; DB/API use English values.
- `is_it` — enum `it | not_it | unprocessed` (default `unprocessed`).
- `hiring_contact_status` — enum `not_checked | found | not_specified` (default `not_checked`). Wellfound-only (see "Hiring contact tracking" below); `hiring_contact_name/role/location` are only ever populated when status is `found`.
- `company_linkedin_status` — enum `not_checked | found | not_specified` (default `not_checked`), same shape as `hiring_contact_status` but NOT source-scoped — applies to any lead with a `company_website`. `company_linkedin_urls` (`text[]`) is null until checked, `[]` once checked and nothing found, the collected link list once `found` — see "Company-LinkedIn discovery" below.
- `published_at` — the vacancy's posted date (parsed from the card).
- **Global dedup indexes:** unique `(source_site, external_job_id)`, unique `(source_url)`.

---

## Parser spec (Techjobs.ca, shared with ITjobs.ca)

**ITjobs.ca (`source_site: "itjobs"`) is a second source added after the manager found it: same
platform/template as Techjobs.ca — confirmed byte-for-byte identical card markup
(`spikes/itjobs_list.html`) and identical JSON-LD `JobPosting` shape on detail pages
(`spikes/itjobs_detail.html`). Reuses `TechjobsListParser` with its own `source_site`/base URL —
no new selectors. It is NOT an "IT-only" feed despite the name: smaller and cleaner than
Techjobs.ca's main list (no cooks/drivers/labourers) but still mixed with non-IT
professional/technical roles (marketing, legal, mechanical engineering, etc.) — Gemini
classification (scope C) still applies to it exactly as for Techjobs.ca.**

### List page (works)
- card: `a[href^="/job/"]`
- `external_job_id`: last path segment (UUID); `source_url`: site's base URL (`https://www.techjobs.ca` or `https://www.itjobs.ca`) + href
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

## Parser spec (Wellfound — third source, DataDome-blocked)

`source_site: "wellfound"`, `wellfound.com`. A genuinely different site (own list markup),
unlike ITjobs.ca — not a template match with Techjobs. **Gemini stays OFF for Wellfound leads
(permanently, not just per-run) — they stay `is_it: "unprocessed"`.** No multi-page (scope D)
support for Wellfound yet — single-page parse only.

### List page (`/role/r/*`)
- card anchor: `a[href^="/jobs/"]` (title text); `external_job_id`: numeric prefix of
  `/jobs/<id>-<slug>`; `source_url`: `https://wellfound.com` + href.
- Cards are NOT self-contained: company name comes from the nearest *preceding*
  `[data-testid="startup-header"] h2` (the page groups job rows under a company section) —
  parsed with one linear document-order scan, not per-card lookups.
- "Job row" (for salary/location) = closest ancestor of the title link containing
  `[data-test="JobApplicationApplyButton"]` (verified 1:1 against job-card count — a more
  stable landmark than Wellfound's Tailwind utility classes).
- Salary vs. location both live in `span.text-xs.pl-1` — disambiguated by a `$` prefix, not
  fixed position (either can be absent, and order isn't reliable in every card).
- No absolute posted date on the list (only relative — "4 days ago", "yesterday", "5 months
  ago"); `published_at` stays null from list parse and is backfilled from the detail page's
  `datePosted` during deepening, same backfill-only mechanism as a Techjobs card with no
  parseable date.

### Detail page — requires a real browser tab, not a fetch
**Confirmed via a real, unauthenticated curl against a live detail URL: HTTP 403 with a
DataDome challenge page (`Set-Cookie: datadome=...`, `X-DataDome: protected`) — not a
client-rendering delay like Techjobs' list page, an active bot-detection block on the raw
HTTP request itself.** The JSON-LD JobPosting (`description`, `hiringOrganization.name/sameAs`,
`datePosted`) is confirmed present once a real browser renders the page
(`spikes/Wellfound_detail.html`) — an access problem, not a parsing problem.

**`DeepeningStrategy` abstraction** (`extension/lib/deepening-strategy.ts`, parallel to the
backend's `Destination` adapter — the orchestrator picks a strategy by `source_site` without
knowing how either works):
- `FetchDeepening` (`extension/lib/deepen.ts`) — the original plain-fetch approach, unchanged
  behavior, used for Techjobs/ITjobs.
- `TabDeepening` (`extension/lib/wellfound-deepen.ts`) — used only for Wellfound. Opens ONE
  dedicated, minimized, unfocused popup window for the whole run (never the manager's active
  window/tab) and reuses its tab by navigating it per lead. A content script
  (`entrypoints/content.ts`, `EXTRACT_WELLFOUND_DETAIL` message) polls the live DOM for the
  JobPosting JSON-LD for up to 15s (hydration can finish after `tabs.onUpdated` "complete") —
  a DataDome challenge page never produces that JSON-LD either, so it fails the same
  timeout path, no separate challenge detection needed. Sequential only, 4-8s between tabs
  (human pace, Wellfound is anti-bot-aggressive). Circuit breaker: stops the whole run after
  `WELLFOUND_CIRCUIT_BREAKER_THRESHOLD` (3) consecutive failures rather than hammering a
  likely-blocked session — surfaced to the manager, never silent. Run cap:
  `WELLFOUND_RUN_CAP` (20) leads per run, a named constant, easy to raise once validated.

---

## Hiring contact tracking (Wellfound) — added later in the project

Some Wellfound postings show a "Hiring contact" section on the detail page (name, role — e.g.
"Employee", "Co-Founder" — and location; location can be legitimately absent even when
name/role are present). Not part of the original brief; added 2026-08-13 as an explicit,
narrow exception to the contact-enrichment prohibition (see "What NOT to do" below) — this is
Wellfound's own on-page data, not a third-party enrichment service, and never touches
email/phone.

- **Extraction** (`extension/lib/wellfound-detail-extract.ts`): anchored on the literal
  "Hiring contact" header text (not a Tailwind class — this site's classes have already
  survived one full redesign, see the Techjobs/ITjobs Parser spec history). Within that
  header's container, the first three "leaf" text elements in document order are name, role,
  location — confirmed against two live postings (one with all three, one with role but no
  location element at all). Read at the same moment as the JobPosting JSON-LD (finding that is
  the signal the page is actually hydrated), via `DeepenedFields.hiring_contact`, a three-way
  result: `undefined` (this strategy doesn't check — Techjobs/ITjobs' `FetchDeepening` never
  sets it), `null` (checked, section genuinely absent), or `{name, role, location}` (found).
- **Three DB states, not a boolean** (`hiring_contact_status`): `not_checked` (default) →
  `found` or `not_specified` once a deepening visit actually looked. Written via a dedicated
  endpoint, `PATCH /leads/:id/contact` (`SetHiringContactDto`), deliberately separate from
  `:id/deepen` — it must never touch description/company/company_website/enrichment_error.
- **Opportunistic save**: every normal Wellfound deepening visit (`deepenWellfoundLeads` in
  `wellfound-deepen.ts` — "auto by all", the dashboard's single-lead Enrich, and bulk Enrich)
  saves whatever `hiring_contact` it found at zero extra cost, since the detail page is
  already loaded. This is how new leads resolve out of `not_checked` going forward.
- **Dedicated backfill** (`extension/lib/wellfound-contact-backfill.ts`,
  `backfillWellfoundContact`) — for leads that were already deepened before this field existed
  (or whose opportunistic save failed): revisits only leads a caller has pre-filtered to
  `hiring_contact_status === 'not_checked'`, so a run — even run repeatedly — never re-touches
  a lead already resolved to `found`/`not_specified`. Reuses `TabDeepening.deepenOne()` purely
  for its extraction (no side effects of its own) plus the same `WELLFOUND_RUN_CAP` (30),
  `WELLFOUND_CIRCUIT_BREAKER_THRESHOLD`, and human-pace delay as normal Wellfound deepening — a
  definitive 404 leaves the lead `not_checked` (couldn't check) and doesn't count toward the
  circuit breaker, same as normal deepening's 404 handling; a timeout/block does count.
  Triggered from the dashboard's "Backfill contact selected" bulk button
  (`BACKFILL_CONTACT_LEADS`, same Port/extension-messaging mechanism as bulk Enrich, sharing
  its in-flight guard since both drive the one dedicated Wellfound background window).
- **Dashboard**: a "Contact" filter (alongside Detail/Error) with options "Has contact person"
  / "Not specified" / "Not detailed for contact person", mapping directly to the DB enum. The
  sidebar shows the resolved value ("Name — Role (Location)"), the Ukrainian marker «не
  вказано» for `not_specified` (same "Ukrainian value labels, English everything else"
  convention as `status`), or the usual `—` for `not_checked`.
- **Run cap**: bumped `WELLFOUND_RUN_CAP` 20 → 30 (2026-08-13, alongside the pagination
  auto-deepen feature) — applies to every Wellfound bulk flow that imports the constant:
  normal bulk enrich, the pagination auto-deepen, and this backfill.

---

## Company-LinkedIn discovery — added later in the project

Given a lead's existing `company_website`, fetch that page and scan it for `<a href>` values
containing "linkedin.com" — the company's own LinkedIn profile (and possibly others, e.g. a
founder's personal profile in the same footer). Added 2026-08-13. **No AI/LLM disambiguation
this pass** — every unique link (exact-duplicate dedupe only, no normalization) is collected
and saved as-is; a future pass could add disambiguation if the raw list turns out noisy.

- **Architecture — deliberately server-side, NOT extension-driven** (unlike every other
  deepening/backfill flow in this project): this is a plain `fetch()` of an arbitrary external
  company website, not a job-site detail page — genuinely different from Wellfound (needs a
  real browser tab for DataDome) or Techjobs/ITjobs (extension-driven because job-site fetches
  go through the extension's own `host_permissions`). No CORS-safe way exists for the
  dashboard's own JS to read an arbitrary external site's response body, so the real fetch has
  to happen server-side regardless — and once it's server-side, there's no reason to make the
  *looping* client-driven too. `backend/src/leads/company-linkedin.service.ts`'s
  `startBackfill()` kicks off an in-process async batch that is **never awaited by its HTTP
  caller** and keeps running in the Node process regardless of whether the dashboard tab that
  triggered it stays open. `GET /leads/company-linkedin/status` is polled by the dashboard
  (every 1s while running) for live progress, and correctly resumes the banner across a
  dashboard page reload since the state lives in this process, not the client. **No extension
  involvement at all for this feature.**
- **Extraction**: regex over the raw HTML (`<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')`),
  same "no DOM library needed, works headless" precedent as the JSON-LD JobPosting extraction —
  no `cheerio`/`jsdom` dependency added for this. A fetch failure, timeout (8s), non-2xx
  response, or malformed `company_website` are all treated identically to "fetched fine, found
  nothing" → `not_specified` — deliberately no failure-reason distinction the way Wellfound's
  404-vs-timeout split has one, per this feature's own spec.
- **Own cap/circuit-breaker**, not reusing `WELLFOUND_RUN_CAP`: `COMPANY_LINKEDIN_RUN_CAP` (50)
  and `CIRCUIT_BREAKER_THRESHOLD` (8, higher than Wellfound's 3) — each request targets a
  *different* external domain, so consecutive failures are a much weaker "we're blocked" signal
  than Wellfound repeatedly failing against the one site it's walking; the breaker here guards
  against a systemic problem (outbound network down), not any single site's own behavior. A
  small fixed 300ms delay between requests (not Wellfound's randomized human-pace — no anti-bot
  reason to vary it here) keeps a run from firing a burst of outbound connections at once.
- **Dashboard**: a "Company LinkedIn" filter (Has company LinkedIn / Not specified / Not
  detailed), a sidebar row listing every found link, and a standalone "Backfill company
  LinkedIn" button — **not row-selection-scoped** like the Wellfound bulk actions, since the
  batch is chosen server-side (every `not_checked` lead with a non-null `company_website`, up
  to the cap). A soft progress banner ("this keeps running even if you close this tab") reflects
  the genuinely different tab-closure semantics from Wellfound's hard "please don't close this
  window" warning — see the architecture note above for why.
- **NFR-3 scope note**: the backend now also fetches arbitrary public company marketing pages
  (read-only, no lead/user data sent to them) in addition to backend/Sheets/Gemini — a new kind
  of outbound call, though not a new category of *data leaving* the system the way NFR-3 is
  really concerned with.
- **Deferred, not built**: some company sites are JS-rendered SPAs where a plain fetch won't see
  footer links a real browser would render. Not addressed this pass — if a first backfill run
  shows fetch failing/coming up empty on a meaningful share of sites, that's a signal to scope a
  TabDeepening-style fallback separately, not something to build preemptively.

---

## What NOT to do (critical) — REVISED

Reversals from the earlier brief (intentional, per the manager meeting):
- **REVERSED — deepening:** we now DO visit each vacancy's detail page to extract description + company website, automatically for all new leads — but at **human pace** (sequential, with delays), never parallel/instant.
- **REVERSED — external API:** we now DO call a free Gemini API for IT-classification. Must be rate-limit-aware and never crash on limits.
- **REVERSED — multi-page:** paging via the URL `?page=N` param is allowed (deprioritized). Still **NO Selenium / no simulated clicks**.

Still forbidden:
- NO contact enrichment (Apollo/Hunter/PDL); NO scraping contact emails/phones. Company name + website only; contacts via LinkedIn manually. **Narrow, explicitly-approved exception (2026-08-13):** Wellfound's own on-page "Hiring contact" section (name/role/location — never email/phone, never a third-party enrichment service) may be scraped and stored — see "Hiring contact tracking (Wellfound)" below. This does not reopen contact enrichment generally; every other source and every other form of contact data stays out of scope.
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

## Dashboard (`backend/src/dashboard/`) — read-only leads browser, plus one write path

Served at `GET /dashboard` (same Google-login-derived session cookie as the extension, see
`backend/src/auth`), reads via the existing `GET /leads` — genuinely read-only except for one
thing below. Not part of the original brief; added later in the project.

- **Filters**: IT filter and Status filter are fixed small enums, hardcoded `<option>`s. The
  **Source filter** is NOT — `source_site` isn't a fixed enum (new sources get added over
  time, see Parser spec history above), so its options are derived from the distinct
  `source_site` values in whatever's actually loaded (`populateSourceOptions()`), not
  hardcoded. All three filter client-side, same as the existing two.
- **"Enrich" button** (lead-detail sidebar, shown only when a lead is missing BOTH
  `description` and `company_website` — i.e. it fell out of deepening): this page cannot
  reach job sites or run `DeepeningStrategy` itself — it messages the **extension**
  (`chrome.runtime.sendMessage(extensionId, {type:"ENRICH_LEAD", leadId, sourceSite,
  sourceUrl})`, via `externally_connectable` scoped to this origin only — see
  `extension/wxt.config.ts`) and the extension's `background.ts` does the actual work,
  routing by `sourceSite` to the exact same `FetchDeepening` (Techjobs/ITjobs) or
  `TabDeepening`/`deepenWellfoundLeads` (Wellfound) used by the batch "auto by all" flow —
  same circuit breaker, same window/tab mechanics, just invoked for one lead. Gemini is never
  triggered by this button, for any source. The extension's id isn't knowable in advance (it's
  assigned per install/load) — the manager pastes it into a small "Extension ID" field once,
  persisted in this browser's `localStorage`. "Extension not installed/unreachable" surfaces
  as a clear inline message, never a silent failure.

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

side panel · thin client + backend · Drizzle · IdP abstraction (Google implemented, Microsoft later) · destination adapter (Sheets) · dedup GLOBAL in the DB (source_url + external_job_id) · owner = created_by, shown only for others in the panel, always in the Sheet · shared visibility (all users see all leads) · status enum + dropdown, shared per lead · UTC in DB, Kyiv on display · snapshot in the DB, flat fields in Sheets · **focus TechJobs, DevITjobs paused** · **deepen description + company website (auto, human pace)** · **Gemini free API for IT-classification (flag, don't delete)** · **contact enrichment stays out — LinkedIn manual** · multi-page via URL param deprioritized · **ITjobs.ca added as a second source, same template/parser as Techjobs.ca, still goes through Gemini (not IT-only despite the name)** · **Wellfound.com added as a third source — own list selectors, deepens via a dedicated background browser tab (DeepeningStrategy abstraction: FetchDeepening vs TabDeepening) instead of a fetch because of DataDome bot-protection, Gemini stays permanently off for it** · **Wellfound "Hiring contact" tracking added as a narrow, explicitly-approved exception to the contact-enrichment prohibition — name/role/location only, scraped from Wellfound's own page (never email/phone, never a third-party service); three-state (not_checked/found/not_specified), opportunistic during normal deepening plus a dedicated backfill for already-deepened leads, reusing the same run cap/circuit breaker** · **Company-LinkedIn discovery added — plain fetch() of company_website scanning for linkedin.com links, no AI disambiguation; deliberately server-side (not extension-driven) since it's an arbitrary external fetch with no CORS-safe client path, own cap/circuit-breaker, dashboard button not row-selection-scoped since the batch is server-picked, soft "keeps running after tab close" banner instead of Wellfound's hard warning**.