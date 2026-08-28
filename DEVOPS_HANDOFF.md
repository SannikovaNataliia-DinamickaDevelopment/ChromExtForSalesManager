# Sales Manager — DevOps Handoff

Accurate technical state of the Chrome-extension + backend lead-collection tool, written for a DevOps engineer coming in fresh. Checked directly against the code and the running local processes/database on 2026-08-25 — not a roadmap, not an aspirational description.

Every claim below is marked **[Verified]** (checked directly tonight — source grep, live query, or a live local HTTP call) or **[Inferred]** (a judgment call, or something plausible I did not independently re-run). Where I wasn't able to verify something, I say so instead of guessing.

**Bottom line up front:** nothing is deployed anywhere. Everything described here runs only as local processes on a developer machine. See §2.

---

## 1. Architecture overview

Three moving pieces, one database. No microservices, no message queue, no separate frontend build for the admin UI.

| Piece | Stack | Talks to |
|---|---|---|
| Backend | NestJS 10 (Express) + TypeScript 5.7, Drizzle ORM | Postgres directly; OpenAI, Gemini, Anthropic, Google Sheets/OAuth over HTTPS |
| Dashboard | Server-rendered by the backend — no separate app | Same process; calls the backend's own REST API from inline JS |
| Browser extension | WXT 0.19 (MV3) + React 18 + TypeScript | Backend REST API over HTTP; scrapes job sites client-side |
| Database | PostgreSQL 16, Docker Compose | Backend only, via `pg`/Drizzle |

### Backend `[Verified]`

NestJS app in `backend/`. Three controllers total: `auth`, `leads`, `dashboard` — no other HTTP surface exists. Persistence is Drizzle ORM over the `pg` driver. Auth is Google OIDC (via `openid-client`) exchanged for the backend's own JWT session (`jsonwebtoken`, 7-day expiry). CORS allows exactly one origin, read from `EXTENSION_ORIGIN` — if that env var is unset, CORS is fully closed (`origin: false`), not open by default.

### Dashboard `[Verified]`

Not a separate frontend. `backend/src/dashboard/dashboard-page.ts` (and a sibling `deleted-leads-page.ts`) are NestJS controllers that return one large HTML document — including a plain, un-bundled JavaScript `<script>` block — as a TypeScript template literal string. No React, no build step, no bundler for this surface. Session is a cookie (`sm_dashboard_session`) issued by the same auth as the extension.

One real consequence for anyone touching it: `tsc` only validates the outer TypeScript file, never the JavaScript text living inside the string. A stray unescaped backtick inside that string has silently truncated the page before with zero compiler error — the only way that's been caught is a manual "extract the script block, unescape it, run `node --check`" pass, which is not scripted or part of any command today.

### Browser extension `[Verified]`

MV3 extension in `extension/`, built with WXT. Entry points: a background service worker (`background.ts`), a content script that auto-injects on matched job-site hosts (`content.ts`), and a React side panel UI.

- Permissions requested: `sidePanel`, `storage`.
- `host_permissions`: `localhost:3000` plus four job sites — techjobs.ca, itjobs.ca, wellfound.com, devitjobs.nl (the last is a paused feature but the permission is still granted).
- `externally_connectable` is scoped to `http://localhost:3000/*` only, used for two things: handing the OAuth session token back after login, and the dashboard's "Enrich" button messaging the extension directly.

**The backend URL is hardcoded** — `BACKEND_URL = 'http://localhost:3000'` in `extension/lib/backend.ts`. Confirmed by source search: nothing in the extension reads `process.env` or `import.meta.env`. Pointing the extension at anything other than localhost means a source change and a full rebuild/redistribution, not a config swap.

### Dev run commands `[Verified — from package.json]`

```bash
# start Postgres (root)
npm run db:up

# backend, hot-reload watch mode (root)
npm run dev:backend        # = nest start --watch, inside backend/

# extension — live dev server (documented default)
npm run dev:extension      # = wxt, inside extension/

# extension — current working practice (see §6, the WXT dev server was unreliable tonight)
cd extension && npm run build   # -> extension/.output/chrome-mv3, load unpacked in chrome://extensions

# schema change workflow
# 1. edit backend/src/db/schema.ts
# 2. cd backend && npm run db:generate   (drizzle-kit generate -> new SQL file under backend/drizzle/)
# 3. cd backend && npm run db:migrate    (drizzle-kit migrate -> applies to the running Postgres)
```

---

## 2. Deployment status

**Nothing is deployed anywhere.** Every piece runs only as a local process on a developer machine right now.

| Item | Status |
|---|---|
| Backend hosted anywhere (cloud, VM, PaaS) | No |
| Dockerfile for the app itself | Not found |
| CI/CD config (`.github/workflows` or similar) | Not found |
| Hosting config (`fly.toml` / `render.yaml` / `Procfile` / `vercel.json`…) | Not found |
| Extension published (Web Store or otherwise) | No |
| Database containerized | Yes — locally only |
| Source control | Private GitHub repo, up to date with `origin/main` |

The only Docker asset in the repo is `backend/docker-compose.yml`, and it provisions **Postgres alone** — it does not build or run the NestJS app. `[Verified]`

This matches the project's own internal documentation (`CLAUDE.md`): the stated design is local-only, service-account Sheets writes, no remote hosting, with cross-machine/cross-PC behavior explicitly deferred until hosting exists.

Practically: the backend is reachable only at `http://localhost:3000` on whichever machine runs it; the dashboard only at `http://localhost:3000/dashboard` on that same machine; the extension only exists as an unpacked build loaded into one developer's Chrome profile. There is exactly one environment today — no staging, no separate prod config, and (verified by source search) **no `NODE_ENV` branching anywhere in the backend code**, so there is currently no code path that behaves differently in a hypothetical production run.

---

## 3. Database

| | |
|---|---|
| Engine | PostgreSQL 16.14 |
| Image | `postgres:16-alpine` |
| DB size on disk | ≈12 MB |
| Migrations applied | 13 (`0000` through `0012`) |

### Row counts `[Verified — live query against the running container tonight]`

| Table | Rows | Notes |
|---|---:|---|
| `job_leads` | 1,468 | wellfound 835 · techjobs 568 · itjobs 50 · devitjobs 15 |
| `users` | 3 | Google OIDC accounts |
| `external_identities` | 2 | linked IdP identities |

### Schema management `[Verified]`

Drizzle ORM + `drizzle-kit` (v0.28). `backend/src/db/schema.ts` is the single source of truth; `drizzle-kit generate` diffs it into a new numbered SQL file under `backend/drizzle/`, and `drizzle-kit migrate` applies pending files against `DATABASE_URL`. 13 migration files exist, all applied to the current local database. No down-migrations are generated by this tool by default — rollback means writing a new forward migration.

### Backups `[Verified — none found]`

**There is no backup mechanism anywhere in this repository.** Searched for `pg_dump`/`pg_restore` usage and any file with "backup" in its name across the whole project — nothing. The only persistence is the single named Docker volume (`pgdata`) on whichever machine runs `docker compose up`. If that volume is lost, the 1,468 leads and everything else are gone.

This is the single most consequential gap in this document for a DevOps engineer to act on before this data is trusted with anything real.

Also worth flagging: `docker-compose.yml` ships with unchanged default credentials (`postgres`/`postgres`). Fine for a machine that's never been reachable from anywhere else, which is the case today — must not travel unchanged into any shared or networked environment.

---

## 4. External dependencies

Every third-party API actually called from a production code path, found by grepping every outbound HTTPS call in `backend/src`.

### OpenAI `[Verified]` — active, paid, no cap

Via the `openai` npm SDK (v7.5.0), default `api.openai.com` base URL, key `OPENAI_API_KEY`. Model used everywhere: `gpt-4.1-mini`.

Two production call sites:
1. **"DM" leadership-contact search** — uses the hosted `web_search` tool; the default/production provider for that feature.
2. **Industry classification** — no tool use, just Structured-Outputs text classification; made the default provider as of the most recent change (Gemini was throwing "high demand" errors during testing).

**Billed per token, no free tier, no budget cap or spend alerting configured anywhere in this codebase.** Observed cost during manual DM testing: roughly $0.01–0.015 per candidate lookup call, self-reported from application log lines — the project's own API key does not have the `api.usage.read` scope (confirmed via a direct 403 earlier in this project's history), so there is no way to pull real aggregate spend from OpenAI's own side today.

### Google Gemini `[Verified]` — free tier, currently degraded

Via plain `fetch()` to `generativelanguage.googleapis.com` (no SDK). Two keys in use:
- `GEMINI_API_KEY` — plain (non-grounded) classification: the original is_it classifier, and the fallback path for Industry classification.
- `GEMINI_API_KEY_LPR_TEST` — the grounded-search DM path, which has a known history of billing/quota problems on this project (no billing linked to that Google Cloud project, per prior investigation).

As of the most recent testing session, the plain-classification path was intermittently throwing "high demand" errors, which is why Industry classification's default provider was switched to OpenAI.

### Anthropic Claude `[Verified]` — installed, not currently usable

Via `@anthropic-ai/sdk`, default `api.anthropic.com`. Key `ANTHROPIC_API_KEY_LPR_TEST` is currently **commented out** in the local `.env` — the code path (`claude-classifier.service.ts`) exists and is selectable for DM search but has no working credential right now. One historical live test cost roughly $0.65/lead, which is why it was never made a default.

### Google Sheets API `[Verified]` — the one write-out destination

Via the `googleapis` SDK, a service-account key file (`GOOGLE_SA_KEY_PATH`, local JSON, gitignored) and `SHEET_ID`. This is the app's only "Destination" — every lead write is mirrored to one Google Sheet. Failures here are deliberately swallowed (try/catch, by design) so a Sheets outage never blocks the primary database write — the tradeoff is that Sheets sync can silently drift with no alerting if the key expires or the sheet is deleted.

### Google OAuth / OIDC `[Verified]` — login only

`accounts.google.com`, used only during sign-in, not a per-request dependency once a session exists. See §8 for a live-tested check of this specifically.

### Job sites — scraped client-side, not a backend dependency `[Verified]`

techjobs.ca and itjobs.ca (identical template), wellfound.com (own template, protected by DataDome — the extension deepens it via a real, dedicated background browser tab rather than a fetch, human-paced with deliberate delays), and devitjobs.nl (paused). These are fetched/scraped from the **extension**, never proxied through the backend, so they don't affect backend infrastructure — but they are a real operational dependency for the product to function at all, and DataDome blocking is an explicit, documented risk the project already works around rather than having solved.

---

## 5. Secrets & environment variables

Every `process.env.*` read found in the backend, plus the extension's (empty) equivalent. Names only, no values. All currently live in local `.env` files — no secrets manager, no vault, no CI injection of any kind.

### Backend — 15 variables `[Verified by source grep]`

```
PORT
DATABASE_URL
DEV_USER_ID
EXTENSION_ORIGIN
JWT_SECRET
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GOOGLE_REDIRECT_URI
GOOGLE_SA_KEY_PATH
SHEET_ID
GEMINI_API_KEY
GEMINI_API_KEY_LPR_TEST
GEMINI_MODEL
ANTHROPIC_API_KEY_LPR_TEST
OPENAI_API_KEY
```

`GEMINI_MODEL` is optional — the code falls back to a hardcoded default if unset. `OPENAI_MODEL` is **not** read anywhere — the OpenAI model is a hardcoded constant in code, not env-configurable.

### Extension — zero variables `[Verified by source grep]`

Nothing in `extension/` reads `process.env` or `import.meta.env`. The backend URL is a hardcoded constant (§1); the extension's own Chrome ID is pasted by hand into the dashboard's `localStorage` once per browser install, not configured via any build-time or runtime env mechanism.

### Where these live today `[Verified]`

`backend/.env` (real values, gitignored) plus a checked-in `backend/.env.example` with placeholders and explanatory comments. One additional local secret file: the Google service-account JSON key referenced by `GOOGLE_SA_KEY_PATH`.

Confirmed via `git ls-files`: neither `.env` nor the service-account JSON is tracked in git — `.gitignore` correctly excludes `.env`, `.env.*`, `service-account*.json`, and `google-sa*.json`. That part is clean. What doesn't exist is any mechanism beyond "a file on this developer's disk" — nothing to carry forward into a second machine or a CI runner today.

---

## 6. Known operational fragility

What actually broke tonight, plus documented platform constraints from the project's own history. Not sanitized — a DevOps engineer needs the specifics.

### Critical

**Two watch processes racing on port 3000.** Observed multiple times this session: a second `npm run dev:backend` (`nest start --watch`) gets started while one is already running, and both fight over port 3000 with no lockfile or singleton guard preventing it. Whichever loses the bind either crashes outright or leaves the pair thrashing logs/PIDs unpredictably. Every recovery required manually enumerating node processes by exact PID (`Get-CimInstance Win32_Process`, filtered on command line) and killing precisely the stray ones — a pattern-based kill would have been faster and also more dangerous to the wrong process.

**`nest-cli.json`'s `deleteOutDir: true` races a standalone build against the live watcher.** Running a standalone `npx nest build` (or `npm run build`) while `nest start --watch` is *also* running wipes `dist/` mid-rebuild out from under the watcher's own incremental compiler. Reproduced twice tonight: the watcher's spawned app process died with `Error: Cannot find module '...\dist\main'` and did not self-recover — needed a full manual kill-and-restart both times.

Practical rule worth encoding somewhere durable: **never run a full build next to a running dev watcher as a "just double-check it still builds" step — it is destructive to the sibling process, not merely redundant.** `tsc --noEmit` (writes nothing) is safe to run alongside the watcher; `nest build` is not.

**`start:prod` points at a path that doesn't exist.** `[Inferred — not yet triggered in practice]` `package.json`: `"start:prod": "node dist/main.js"`. Given `nest-cli.json`'s `sourceRoot: "src"`, the real compiled entrypoint is `dist/src/main.js` — confirmed by inspecting the actual build output directory. Running `npm run start:prod` today would fail immediately with the same `MODULE_NOT_FOUND` error as the point above. Nobody has apparently run this script yet, consistent with §2 — fix this as part of writing the Dockerfile, not after something fails in a container for the first time.

### Moderate

**Extension's live WXT dev server was unreliable this session.** Investigated a blank/white side-panel issue traced to the `wxt` dev server dying (stdin EOF in this shell environment) with no clean crash signal. Current working practice — not a permanent fix — is `wxt build` + manually reloading the unpacked extension in `chrome://extensions` instead of relying on live HMR.

**MV3 service-worker idle-kill during long background flows.** `background.ts` is unloaded by Chrome after roughly 30 seconds with no tracked extension-API activity. Human-paced bulk flows (Wellfound deepening/enrich, which deliberately pauses between steps) can outlive that window and get the worker killed mid-flow — this surfaced once as a misleading "open the side panel first" error even with the panel open. Worked around with keep-alive pings and a self-healing side-panel port; this is an inherent MV3 platform constraint, not something permanently solved — any new long-running background flow needs to account for it again.

**No retry/backoff layer for any LLM provider.** A 429/quota response from Gemini or OpenAI is caught and the affected lead is simply left unprocessed/unclassified for a human to re-trigger — no queue, no exponential backoff, no circuit breaker at the HTTP-client level. The one exception is DM search's own application-level retry (up to 3 attempts per candidate), which exists for search-result variance, not rate limiting.

### Minor

**No health-check endpoint.** Confirmed by a full controller listing: only `auth`, `leads`, `dashboard` exist — nothing at `/health` or similar. Anything that wants to liveness/readiness-probe this service has nothing purpose-built to hit today.

**Zero automated tests, zero CI, zero linting.** Confirmed: no `*.spec.ts`/`*.test.ts` files anywhere, no test script in either `package.json`, no ESLint or Prettier config anywhere in the repo. Every "does this still work" check this session was manual — typecheck, watch the recompile timestamp, trigger a real API call by hand and read the result.

---

## 7. Build / validate commands

What actually gets run today to check a change is good. Close to a starting CI script, with the gaps called out.

### Works today `[Verified — run repeatedly this session]`

```bash
cd backend
npx tsc --noEmit -p tsconfig.json   # typecheck only — safe next to a running watcher
npx nest build                       # full build — ONLY safe when nest start --watch is NOT also running (see §6)
```

### Probably works, not verified this session `[Inferred]`

```bash
cd extension
npx tsc --noEmit                     # WXT generates its own .wxt/tsconfig.json — plausible but not exercised tonight
npx wxt build                        # confirms the extension packages; output isn't validated by anything today
```

### Does not exist yet

- Any test suite (unit, integration, or e2e) for either `backend/` or `extension/`.
- Any lint or format step.
- Any check that `backend/src/db/schema.ts` and the checked-in SQL migrations under `backend/drizzle/` haven't drifted apart.
- Any automated validation of the dashboard's embedded JavaScript string beyond the manual "extract, unescape, `node --check`" technique used ad hoc this session — not scripted, not part of any command above.

A reasonable first CI job today is exactly the two backend commands above (a build in a fresh CI container has no watcher to race, so it's safe there even though it isn't safe locally next to one) — everything past that needs to be written before it can gate anything.

---

## 8. Google OAuth login status

`[Verified — live-checked tonight, read-only]`

Checked two things directly, without completing a real login (no test Google account was used or needed for this level of check):

1. **Credentials are populated, not placeholders.** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI` in `backend/.env` all hold real-length values (checked lengths only, not the values themselves, to avoid putting secrets in this document).
2. **`GET /auth/login` was hit directly against the running local backend.** It returns `HTTP 302` and redirects to a correctly-formed `https://accounts.google.com/o/oauth2/v2/auth` URL, with:
   - a populated `client_id` matching a `*.apps.googleusercontent.com` value,
   - `scope=openid email profile`,
   - `response_type=code`,
   - `redirect_uri=http://localhost:3000/auth/callback` (matching the configured `GOOGLE_REDIRECT_URI`),
   - a signed JWT `state` parameter (short-lived, 5-minute TTL by design) and a `nonce`.

**What this confirms:** the OAuth *initiation* is correctly configured — a real Google Cloud OAuth client ID is wired up, the redirect URI matches what's registered in code, and the login flow starts correctly.

**What this does not confirm:** I did not complete an actual login (that requires a real Google account making an interactive consent decision, which isn't something to script). So the `GOOGLE_CLIENT_SECRET`'s validity — only exercised during the token exchange at `/auth/callback` after a real consent — is **not verified** by this check. Nor have I verified, from inside this repo, that the redirect URI is actually registered as authorized in the Google Cloud Console project (that state lives in Google Cloud, not this codebase).

---

## 9. Other gaps for containerizing / deploying / monitoring

Judgment calls, not verified facts — flagged as such throughout.

**Topology is simpler than it might look.** `[Inferred]` The dashboard has no separate frontend to deploy — it's rendered by the same backend process. That collapses the deployable surface to "one Node service + Postgres," which is worth knowing before reaching for a more elaborate topology than this actually needs.

**The extension is a genuinely separate release lifecycle.** `[Inferred]` It has its own distribution question (Chrome Web Store vs. manual/packed distribution — today, neither is set up; every install so far is "load unpacked" on a developer machine), and its hardcoded backend URL (§1) means every environment the backend gets deployed to requires an extension rebuild, not a config change.

**Auth setup has an out-of-repo dependency.** `[Inferred]` A real Google Cloud OAuth client must exist and have the right redirect URIs authorized for any new origin this ever runs on (see §8) — that Cloud project's full configuration isn't visible from this codebase.

**Cost exposure is the thing to get ahead of.** `[Inferred]` OpenAI is now the unmetered-from-our-side, no-cap dependency for both DM search and Industry classification (§4). The product owner has explicitly flagged, and not yet decided, whether to run Industry classification automatically across the full ~1,468-lead database — that would be this project's first real, quantifiable cloud cost, worth costing out (and possibly capping/rate-limiting deliberately) before that switch gets flipped, not after.

**One in-process cron job to know about.** `[Verified]` `@nestjs/schedule` runs a daily job (midnight, server-local time) that purges soft-deleted leads after a 30-day retention window. It only fires while the Node process stays continuously running — there's no external scheduler behind it. Fine as a single long-lived process today; would need attention if this ever runs as multiple replicas or gets restarted frequently.

**Monitoring: there is none.** `[Verified — none found]` No logging aggregation, no error tracking (Sentry or similar), no metrics/APM of any kind found in dependencies or code. Today's only observability is `console.log`/NestJS's own logger writing to stdout, read by hand.

---

*Prepared by direct inspection of the repository and the live local database/backend process on 2026-08-25. Repo: `SannikovaNataliia-DinamickaDevelopment/ChromExtForSalesManager`, branch `main`.*
