# Sales Manager Chrome Extension

A Chrome extension + backend that parses job listings (Techjobs.ca, ITjobs.ca, Wellfound, Indeed), enriches them (Apollo/OpenAI), and gives a sales manager a dashboard of leads ready for outreach. See `CLAUDE.md` for the full project brief (data model, API, parser spec, scope, decision log) and `DEVOPS_HANDOFF.md` for a deeper technical audit of the current state (architecture, external dependencies, operational fragility) — this README is the practical "how to actually run/deploy this" doc.

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
3. "Load unpacked" → select `extension/.output/chrome-mv3-dev/`. (Dev and prod builds land in separate, distinctly named folders — see "Distributing the extension" in Part 2 — so building one never overwrites the other; both can be loaded side by side on one machine if you ever need to.)
4. Set `EXTENSION_ORIGIN=chrome-extension://<the dev ID>` in `backend/.env`, then restart the backend. (The dev build's ID is stable across reloads/rebuilds now — see Part 2 — so you only need to do this once, not after every reload.)

### 7. Try it

1. Open a Techjobs.ca, ITjobs.ca, Wellfound.com or any Indeed (`*.indeed.com`) job-list page in a normal Chrome tab.
2. Open the extension's side panel (click the toolbar icon).
3. Click **Parse current list page** (or use the date-range auto-parse for Wellfound / the all-regions auto-parse for Indeed) — parses job cards and posts them to `POST /leads`.
4. Open `http://localhost:3000/dashboard` (same Google login) to browse, filter, enrich, and export leads.

**Keep the backend's terminal window open** while you work — closing it stops the backend (the dashboard and the extension then fail to load data). After a PC restart: start Docker Desktop first (Postgres comes back by itself), then `npm run dev:backend`.

---

## Indeed — how it works, and how it differs from Wellfound

Indeed was added as a source in September–October 2026 (task DI-2966). Summary of what is specific to it:

| | Wellfound | Indeed |
|---|---|---|
| Domains | one (`wellfound.com`) | **62 country domains** (`www.indeed.com` = USA only — there is no cross-country domain). One click in the side panel walks every selected country one after another, with the search query of the open tab; all 62 are selected by default (region dropdown, choice remembered per browser). Country list: `extension/lib/indeed-regions.ts` |
| List data | page DOM + `__NEXT_DATA__` | the page's embedded JSON model (`#mosaic-data`), not the DOM — `extension/lib/parsers/indeed.ts` |
| Pagination | `?page=N` | follows Indeed's own **Next** link (`&start=N` only as a fallback); a region ends when no Next link is rendered — `extension/lib/indeed-pagination.ts` |
| Date range | precise date from the page | ranges starting within the last 14 days use Indeed's own "Date posted" filter (`fromage` 1/3/7/14) to keep runs short, then the exact range is applied **in each country's own time zone**; `published_at` = the later of Indeed's create/publish dates (a repost counts as current) |
| Location | from the tab | **always "Remote"** in every country (remote-only hiring); only the query is carried over from the tab |
| Bot protection | DataDome — background window minimized | **Cloudflare checkbox** on some pages: the run pauses (up to 10 min), raises the window, shows a Windows notification and a red "!" on the toolbar icon; **a human ticks the box** — it is never solved automatically |
| Detail page (deepening) | real background tab, JSON-LD | real background tab (a plain fetch is always HTTP 403); only the **description** is read from the embedded `preloadedVJData` |
| Company website | in the posting's JSON-LD | **not provided by Indeed** — see "Company website for Indeed" below |
| Hiring contact | yes (Wellfound's own section) | no |
| Gemini IT filter | off | off |
| Dashboard Enrich | real tab, side panel must be open | same (single and bulk) |

### Company website for Indeed

Indeed exposes a company name but no website, while Apollo (industry + decision-makers) needs one. Sources, in order of reliability shown on the dashboard:

1. **Confirmed** — a manager picked/confirmed it (dashboard "Confirm website", or "Find company in Apollo" — Apollo Organization Search by name, 1 Apollo credit per new search, cached 24 h).
2. **AI verified** — the AI website finder (`backend/src/leads/ai-website.service.ts`): one OpenAI call (`gpt-4.1-mini` + web search) **per company, not per lead**, then a free check — the site must load and mention the company; parked / for-sale / non-existent domains are rejected.
3. **AI guess / description guess** — found but not verified (AI unsure, site blocked the check, poster is a recruiting agency, or a domain mentioned in the job description). Marked **"!"** in the dashboard; Apollo searches for such leads require an explicit confirmation (enforced by the backend too — `409 UNVERIFIED_COMPANY_WEBSITE`).

Measured on 89 Indeed companies (Oct 2026): 72% AI-verified, 24% found with "!", 4% not found; ~$0.013 OpenAI per company; a manual check of 20 random AI-verified websites found 20/20 correct.

### Company data is shared across all leads of a company (all sources)

`backend/src/leads/company-data-sync.service.ts`: whatever is found once for a company is copied to its other leads, and a newly parsed lead of a known company gets it immediately — **no OpenAI/Apollo call**. Website, Apollo organization id + industry, company LinkedIn and the AI "no website found" note are shared across all countries; **decision-makers (DM) only between leads in the same country** (a large company's regional leaders differ). "Same company" = name without case, accents, punctuation and legal form (`company-key.ts`).

### No automatic OpenAI / Apollo calls

Nothing paid runs automatically after parsing:
- **OpenAI** (AI website finder) runs only from the dashboard's **"AI website selected"** button, after a confirmation that shows the number of companies and the estimated cost (max 40 companies per run; stops on the first quota error). An automatic run after deepening exists but is **off** (`AI_WEBSITE_AUTO` unset) and has not been enabled.
- **Apollo** runs only from the dashboard: **DM Search** (sidebar), **DM Search + Industry selected** (bulk), **Find company in Apollo**.
- **Gemini** is never called for Indeed leads.

Free automatic steps: parsing, deepening, website-from-description, the free site check, company data sharing.

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

**Upgrading an existing database** (e.g. one deployed before the Indeed work): run the same `npm run db:migrate` — it applies only what's missing. The Indeed release adds two migrations, both additive (no existing data is changed): `0016` (`company_website_source` enum + column) and `0017` (enum values `ai_verified`/`ai_guess` + `company_website_note` column).

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
| `OPENAI_API_KEY` | Yes (DM/LPR search's default provider; the AI website finder for Indeed) | platform.openai.com — **org-owned, billing-capable account.** No free tier, and this codebase has no spend cap or budget alerting configured anywhere — factor that into whichever account/card you attach this to. The AI website finder costs ~$0.013 per company and only runs on an explicit dashboard click. |
| `APOLLO_API_KEY` | Yes (DM/LPR search's Apollo provider, industry data) | developer.apollo.io — free account; note `mixed_people/api_search` is free but `people/bulk_match` consumes paid credits per person found |
| `GOOGLE_SHEETS_SYNC_ENABLED` | No — leave unset/false | Google Sheets sync is disabled by design as of 30.08 (the dashboard replaced it) — only set to `true` if you deliberately want it back, and only then do the two vars below matter |
| `GOOGLE_SA_KEY_PATH` / `SHEET_ID` | No | Only needed if `GOOGLE_SHEETS_SYNC_ENABLED=true` |
| `GEMINI_API_KEY_LPR_TEST` | No | Alternate DM-search provider; this project's own history notes billing/quota issues on this key specifically — not part of the recommended path |
| `ANTHROPIC_API_KEY_LPR_TEST` | No | Alternate DM-search provider; a live test on record cost ~$0.65/lead — don't enable this as a default, it's roughly 5-6x OpenAI's cost |
| `GEMINI_MODEL` | No | Falls back to a hardcoded default if unset |
| `AI_WEBSITE_AUTO` | No — leave unset | `true` makes every freshly deepened lead without a reliable website go to the AI website finder automatically (spends OpenAI credit without a click). **Not enabled** — whether to turn it on is Artem's call (he manages the OpenAI/Apollo budgets) |
| `AI_WEBSITE_MOCK` | No — leave unset | `true` = the AI website finder makes no OpenAI call and saves nothing (UI testing only) |
| `APOLLO_COMPANY_SEARCH_MOCK` | No — leave unset | `true` = "Find company in Apollo" shows clearly marked sample candidates and saves nothing (UI testing only) |

**Outbound network:** besides Google, OpenAI and Apollo, the backend fetches **arbitrary public company websites** (the free check of AI-found websites, and the existing company-LinkedIn discovery) — allow general outbound HTTPS from the backend host.

**Maintenance scripts** (run from `backend/`, after a build; all free — no OpenAI/Apollo calls):
- `npm run sync-company-data` — share company data across all leads of each company (normally automatic; useful after a bulk import)
- `npm run backfill-website` — guess websites from job descriptions for leads saved before that feature
- `npm run reverify-ai-websites` — re-run the free site check on saved AI websites

**Note on industry classification:** an LLM-based "Classify Industry" feature existed but was deliberately disabled on 01.09 (client decision — Apollo's own raw industry field is used directly instead, no AI interpretation). The button is intentionally inert; this is not a bug.

### Google OAuth setup

Login is Google OIDC. Whoever controls the Google Cloud project backing `GOOGLE_CLIENT_ID` needs to add the real deployed backend's callback URL (`https://<your-deployed-backend>/auth/callback`) as an **authorized redirect URI** in that OAuth client's Google Cloud Console settings — this is Google Cloud configuration, not something in this repository, and login will fail with a redirect-mismatch error until it's done.

### Distributing the extension (not published to the Chrome Web Store)

The extension is not going through the Chrome Web Store. It has **separate, independent dev and production builds** (WXT's own env-mode mechanism — `.env.development` / `.env.production` in `extension/`), each with its own permanently stable Chrome extension ID (derived from a dedicated RSA keypair per build, not reassigned on every install):

- **Production build:** `npm run build --workspace extension` (or `npx wxt build` from `extension/`) — uses `extension/.env.production`'s `WXT_BACKEND_URL`. **Before building for real deployment, edit that one line to the actual deployed backend URL** (it is still the placeholder `https://REPLACE_WITH_PROD_BACKEND_URL`) — everything else (manifest key, permissions) is already wired to read from it.
- **Permissions added with the Indeed release:** host access to `https://*.indeed.com/*`, `notifications` (Cloudflare-check alerts) and a toolbar action (badge). Chrome asks the user to accept the new permissions when the updated build is loaded.
- The production extension's Chrome ID is fixed by its keypair (`extension/keys/prod-key.pem`, gitignored — **back this file up somewhere outside this machine**; losing it means the production extension's ID changes on the next build, breaking the deployed backend's `EXTENSION_ORIGIN` and requiring Mariia to reinstall).
- Dev and production builds land in **separate, distinctly named** output folders — `extension/.output/chrome-mv3-dev/` and `extension/.output/chrome-mv3/` respectively (`wxt.config.ts`'s `outDirTemplate: '{{browser}}-mv{{manifestVersion}}{{modeSuffix}}'`, WXT's own built-in mode-suffix placeholder — confirmed by building both modes back to back and inspecting both folders' output simultaneously). Building one never overwrites the other, so both can be loaded side by side on the same machine if you ever need to.
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
- The DM-search module `apollo-classifier.service.ts` still logs raw Apollo responses (`[APOLLO DEBUG]` lines) — it predates the Indeed work and was deliberately left untouched, since production runs its own, reworked Apollo logic (see "Release handoff").
- Company grouping ("same company") is computed in application code over all leads — fine at the current size (hundreds of rows); revisit with a stored key column if the table grows large.

---

## Release handoff

Day-to-day work happens in this GitHub repository (feature branches, e.g. `fix/indeed-pagination` for the Indeed release). **The handoff for review and production goes through the corporate GitLab** (`gl.dinamicka.info`, project `teamprojects/job-site-parser`): the release branch is transferred there and reviewed by Artem, who merges and deploys it. **Apollo in production differs from this repository.** Production runs a reworked Apollo integration that this branch does not have, so the Indeed work will be adapted to it during review. The places where this branch touches Apollo — all optional for Indeed parsing itself:
- `backend/src/leads/apollo-company-search.service.ts` + `POST /leads/:id/company-match` + the dashboard's "Find company in Apollo" modal — company lookup by name (`mixed_companies/search`), new in this branch.
- The "!" gate before Apollo: `LeadsService.lprSearch` (`confirmUnverifiedWebsite`) and `ApolloBulkSearchService.startBatch` (`confirmUnverifiedWebsites`) refuse leads whose website is `description_guess` / `ai_guess` without an explicit confirmation; the dashboard asks first.
- `backend/src/leads/company-data-sync.service.ts` copies Apollo results between leads of one company (organization id + industry fields everywhere; `lpr_*` decision-makers only within the same country) and is triggered after `lprSearch`.
- The AI website finder (OpenAI) only fills `company_website`; it doesn't call Apollo.

**Automatic runs are not enabled.** Neither the AI website finder (`AI_WEBSITE_AUTO`) nor any Apollo call runs automatically after parsing; enabling automation is Artem's decision, as he manages the OpenAI/Apollo credits.

Checklist for the production deploy of the Indeed release:
1. `npm run db:migrate` (adds migrations 0016–0017).
2. `OPENAI_API_KEY` and `APOLLO_API_KEY` set on the server; `AI_WEBSITE_AUTO` / `*_MOCK` left unset.
3. Outbound HTTPS from the backend allowed to arbitrary sites (see above).
4. `extension/.env.production` → real backend URL, then the production extension build; users accept the new permissions.
