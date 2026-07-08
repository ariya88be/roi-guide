# DECISIONS.md

Chronological log of meaningful decisions: date, what was built, why, any issue
found, and the fix. Newest at the bottom.

---

## 2026-07-06 — Project kickoff & scope decisions

**What:** Locked the seven open questions from the brief before writing code.

| Question | Decision | Why |
|---|---|---|
| Geography | Greater Los Angeles metro | Lowest data cost; matches the Koreatown worked example; prove the pipeline on one market first. |
| Data budget | ~$100/mo ceiling to start | Comfortably covers RentCast Pro + light ATTOM for one metro at 12–24h refresh; spend alerts to be added. |
| ROI scope | Pre-tax cash flow is the real number; no true post-tax modelling | Keeps the core honest and simple; avoids pretending to tax precision. |
| After-tax | One rough, clearly-labelled estimate (depreciation shield only) | Owner wants an easy-math view without a tax engine. |
| Mortgage | Fixed conservative defaults **and** sliders + all-cash toggle, both in Phase 1 | Owner wants full interactivity from the start. |
| Rent basis | Median of comps (0.5→1 mi, 90-day window); AVM shown alongside | Brief §2.5 — median resists outliers; AVM is a cross-check, not the headline. |
| Colours | **Continuous gradient** keyed to cashFlow/target, anchored at T/1.5T/2T/3T | Owner asked for a real heatmap gradient, not three discrete colours. |
| Exclusions/types | Full brief list; SFH/condo/townhome/2–4 unit included; 5+ unit deferred | Larger multifamily underwrites differently — revisit later. |

**Colour change (supersedes brief §6 three-colour table):** pins now use a
continuous ramp. The old band edges T/1.5T/2T survive as gradient anchor stops
and legend ticks. Direction is a single config flag; a colourblind-safe
(viridis) palette is selectable; every pin still shows its dollar figure and a
text band label so colour is never the only signal.

**After-tax scope (rough estimate):** models only the depreciation tax shield
(`price × buildingFraction / 27.5 × marginalRate`), ships with a mandatory
disclaimer, and ignores interest deductibility, passive-loss limits, bracket
effects, state tax, and recapture.

---

## 2026-07-06 — Toolchain: Node LTS in userspace

**What:** No Node/npm on the machine (Bun 1.3.14 was present). Installed Node
24.18.0 LTS (Krypton) into `~/.local` (symlinked into `~/.local/bin`, already on
PATH). No sudo/Homebrew needed.

**Why:** Production runs on Railway with a Node runtime and the whole pinned
stack (Next.js, Drizzle, Vitest, Playwright, n8n) is Node-native. Standardising
on Node keeps local === prod. Bun remains available as a fast package manager if
we choose it later, but is not the runtime of record.

---

## 2026-07-06 — Scaffold & the ROI engine (Phase 1, increment 1)

**What:** `create-next-app` (Next 16.2.10, React 19, TypeScript, Tailwind 4,
ESLint 9, App Router). Added Vitest 4. Built the pure ROI engine under
`lib/roi/` with full unit tests (49 tests, all green; `tsc --noEmit` clean):
- `statistics` — median/percentile/IQR/stdev/CV (median-not-mean enforced).
- `amortization` — mortgage P&I incl. 0%-rate and all-cash edge cases.
- `defaults` — frozen conservative defaults.
- `cashflow` — full monthly pre-tax cash flow with per-line provenance and
  flags (HOA missing, tax/insurance estimated); negative CF labelled.
- `confidence` — rent-confidence score (count/spread/recency); thin sample
  forces Low + de-emphasis.
- `color` — continuous cashFlow→colour gradient + band classification + legend.
- `afterTax` — rough depreciation-shield estimate with disclaimer.

**Issue found:** `npm audit` flagged a moderate `postcss <8.5.10` advisory
(transitive under Next). `npm audit fix --force` "resolves" it by downgrading
Next to 9.3.3 — a destructive false fix.

**Fix:** Added an npm `overrides` entry pinning `postcss ^8.5.10`. Re-audit
reports **0 vulnerabilities**. Did not run the forced downgrade.

**Why engine-first:** it is the honest core and the thing most likely to be
subtly wrong. Building and testing it in isolation (no I/O) before any UI/API
means every downstream consumer inherits verified maths.

---

## 2026-07-07 — RentCast provisioning + server-only client (Phase 1, increment 2)

**What:** Created a RentCast account (via Chrome, owner did account creation +
plan choice; assistant generated the API key), stored the dev key in
`.env.local` (gitignored). Verified it live against zip 90020: **median rent
$1,850 vs average $2,124**, min $809 / max $9,998 — a real, first-call
demonstration of the mean-vs-median skew the product exists to defeat.

Built `lib/providers/rentcast/` (server-only): Zod schemas for market / sale
listings / rent AVM; a client with X-Api-Key auth (never logged, never in URL or
cache key), exponential-backoff+jitter retry on 429/5xx/network errors
(honours Retry-After), fail-fast on non-retryable 4xx, response validation, and
a pluggable cache (in-memory now; Redis when provisioned). All time/random/fetch
injectable → deterministic tests. Added Zod 4.4.3.

**Tests:** 60 total green (11 new for the client, covering QA §15.G). `tsc` clean,
`npm audit` clean.

**Deferred:** a live integration test that runs only when `RENTCAST_API_KEY` is
present (to avoid burning the 50-call free quota in CI) — add when ingestion
lands. Malformed-JSON-on-200 currently surfaces a raw SyntaxError; low priority,
noted for hardening.

**Boundary held:** account creation / password / plan selection were done by the
owner, not the assistant (per the standing safety rules); the assistant only
generated the API key and wired it into the gitignored env file.

---

## 2026-07-07 — Data model: Drizzle schema + PostGIS + RLS (Phase 1, increment 3)

**What:** Authored the full schema offline (no DB yet). 8 tables: market-data
(`properties`, `listings`, `rent_comps`, `market_snapshots`, `computed_roi`)
and user-owned (`users`, `saved_searches`, `alerts`). PostGIS
`geometry(Point,4326)` + GiST indexes on `properties.location` and
`rent_comps.location`. `db/client.ts` exposes a server-only pool and
`withUser()`. Added drizzle-orm 0.45.2, drizzle-kit 0.31.10, postgres 3.4.9 and
`db:*` scripts. Generated migration `0000_*.sql`.

**Per-user isolation (§9 / OWASP A01):** every user-owned row has `user_id NOT
NULL`; migration enables + FORCES Row-Level Security with policies keyed to
`current_setting('app.user_id', true)` (unset ⇒ zero rows, fail-closed).
`withUser()` sets that GUC per transaction via a *parameterised* `set_config`.
Defence in depth: the query layer will also filter by `user_id` explicitly.

**Issues found & fixed:**
1. drizzle-kit emitted `geometry(point)` — the **SRID 4326 was dropped** from the
   DDL. Hand-corrected both columns to `geometry(Point,4326)` in the migration.
2. drizzle-kit does not manage extensions or RLS. Hand-added `CREATE EXTENSION
   IF NOT EXISTS postgis` (before the first geometry table) and the full RLS
   block (enable/force/policies) to the migration.
3. Added `db/migrations.test.ts` static guards so a future `db:generate` that
   drops the PostGIS/SRID/RLS DDL fails CI loudly.

**esbuild advisory:** installing drizzle-kit pulled a moderate, **dev-only**
esbuild advisory (via `@esbuild-kit/*`, dev-server CORS — not in our runtime).
The §15.M gate (no *high*-severity) was already met; cleared it fully anyway with
an `esbuild ^0.25.0` override. `npm audit` = 0 vulnerabilities; drizzle-kit still
works.

**Tests:** 67 total green. `tsc` clean.

**Deferred (needs a live DB — do in the Railway session):** actually run the
migration; real PostGIS viewport/radius query tests (QA §15.H) and a live IDOR/
RLS cross-tenant test (QA §15.M).

---

## 2026-07-07 — Listing-hygiene / exclusion engine (Phase 1, increment 4)

**What:** `lib/hygiene/` — the pure "false-impression-proof" screen. Normalises
provider status/type strings to bare tokens, then applies conservative rules:
- status must be Active (any non-Active, known or unknown, is excluded);
- excluded listing types: foreclosure, pre-foreclosure, auction, REO, bank-owned,
  short-sale, new-construction;
- property-type ALLOWLIST (single-family, condo, townhome, 2–4 unit multifamily);
  raw land called out specifically; 5+ unit multifamily excluded via record or
  type-implied unit count;
- 55+ senior-restricted excluded;
- freshness: inactive flag, missed-sync count ≥ N, or stale lastSeen all exclude.

Returns a render decision plus **coded, surfaceable reasons** (never a silent
drop), and a batch partition helper. Clock injected → deterministic.

**Design choice:** allowlist + fail-closed (unknown status/type ⇒ exclude). We
would rather hide a borderline-valid listing than show a distressed/stale/wrong
one — that directly serves the product's core honesty promise.

**Tests:** QA §15.D covered; suite now 110 green. `tsc` + `npm audit` clean.

**Deferred to Phase 2:** cross-checking sold status against a second source
(ATTOM) — this screen is status/feed-based only for now.

---

## 2026-07-07 — Railway provisioning + RLS-superuser fix + live tests (Phase 1, increment 5)

**What:** Provisioned the database and cache on the owner's existing Railway
account (new project `romantic-tenderness`). Postgres + Redis online; migration
applied; schema verified live.

**Issue 1 — no PostGIS in Railway's default image.** `ls .../extension/` showed
`NO_POSTGIS_FILES`. Swapped the Postgres service image to `postgis/postgis:18-3.6`
(verified that tag exists via Docker Hub API first — `18-3.5` does NOT exist for
PG18). It started cleanly on the existing volume (no SSL-cert issue); PostGIS 3.6
(GEOS+PROJ) now available. Verified live: SRID-4326 geometry, both GiST indexes,
RLS enabled+forced, isolation policies present.

**Issue 2 (the important one) — superusers bypass RLS.** Railway's default
connection user `postgres` is a SUPERUSER, and PostgreSQL superusers bypass RLS
*even when FORCED*. Connecting the app as `postgres` would have made all our
per-user isolation silently decorative — a false-security bug. Fix: created a
dedicated non-superuser role **`roi_app`** (NOSUPERUSER, NOBYPASSRLS) with
least-privilege DML grants (`scripts/setup-app-role.mjs`, password from env,
never committed). Runtime now connects via `APP_DATABASE_URL` (roi_app);
`DATABASE_URL` (postgres) is reserved for migrations (needs superuser for
CREATE EXTENSION). `db/client.ts` prefers `APP_DATABASE_URL`.

**Live tests (`db/integration.test.ts`, gated on `APP_DATABASE_URL`):**
- QA §15.H geospatial: bbox envelope returns exactly the inside points; radius
  (ST_DWithin over geography) returns the correct nearby set nearest-first; the
  bbox query plan uses `properties_location_gix` (GiST) under `enable_seqscan=off`.
- QA §15.M isolation, connected as `roi_app`: a user sees only their own rows;
  IDOR SELECT and UPDATE of another user's row both return zero; a connection
  with no `app.user_id` sees zero rows (fail-closed).
- Suite: 117 green with DB env; 110 pass / 7 skip without it (CI stays offline-safe).

**Secret handling:** connection strings pulled from Railway via the UI copy
button → OS clipboard → `pbpaste` into gitignored `.env.local`, so passwords
never appeared in a screenshot or the chat. `.env.example` documents both URLs.

**Billing note:** Railway account is on a TRIAL ("5 days / $0.87 left"). Services
pause when it lapses; upgrading is the owner's decision (usage-based Hobby ~ $5/mo
+ usage, within the $100 ceiling).

---

## 2026-07-07 — Ingestion pipeline + first live data (Phase 1, increment 6)

**What:** `lib/ingest/` — RentCast → hygiene screen → ROI compute → idempotent
persist. Pure mappers/compute (unit-tested); `persist` upserts properties/
listings/computed_roi/market_snapshots with explicit `ST_SetSRID(...,4326)`
geometry; `ingestZip` orchestrates with injectable client + db.

**Schema:** added a unique index on `listings(property_id, source)` as the
idempotent-upsert key (migration 0001, applied live).

**Phase-1 rent basis decision:** use the ZIP **bedroom-matched median** from one
RentCast market call per ZIP, instead of a per-property AVM call each — stays in
the 50-call free-tier budget. Confidence is therefore coarse and never "High"
(honest about being ZIP-level); property-level median-of-comps + real confidence
is Phase 2.

**`computed_roi.color_band` semantics:** it stores the target-INDEPENDENT cash-
flow SIGN (positive/negative/breakeven). The map's gradient colour is target-
RELATIVE and computed at render by `lib/roi/color.colorForCashFlow(cf, target)` —
a precomputed band can't exist before the user picks a target. (Column keeps its
name to avoid a rename migration; documented here + in code.)

**Tests:** pure mapper/compute unit tests + a live integration test (mock client,
real DB) proving screening drops Sold/Land and re-runs are idempotent (no dup
rows) — QA §15.G. Suite: 132 with DB env, 122 pass / 11 skip offline.

**First live run (owner switched target market to San Bernardino):** ingested ZIP
92404 — 21 real properties. Market median $1,640 vs mean $1,831 (the skew we
defeat). At conservative default financing (20% down, 7%, 30yr, full reserves)
ALL pins are cash-flow negative (best: $160k 1bd condo at −$203/mo). This is the
product working as intended — naive tools would call several "profitable"; the
all-cash / down-payment sliders will reveal which flip positive. Koreatown (90020)
test data was removed so San Bernardino is the clean starting market.

---

## 2026-07-07 — Viewport-pins API + MapLibre map (Phase 1, increment 7)

**What:** The map — finally something to see. `/api/pins` (GeoJSON, GiST bbox
query, target/budget filter, per-pin gradient colour) and `/api/property/[id]`
(full itemised breakdown), both rate-limited (Redis/ioredis) and Zod-validated,
generic error responses. `MapView` renders MapLibre pins over San Bernardino with
$-labels, filter controls, legend, and a click→detail card that shows every
expense line ("never a bare number").

**Read the Next 16 docs first (per AGENTS.md).** Captured the breaking changes in
CLAUDE.md: async `params`/`searchParams`/`cookies`/`headers`; `ssr:false` needs a
client page; `next lint` removed. Would have silently bitten otherwise.

**Design decision — recompute cash flow per request from the user's assumptions**
(not just the precomputed financed default). At 7% financing EVERY San Bernardino
property is cash-flow negative, so a positive target on the financed default is an
empty map. Recomputing per-listing with the pure engine makes the sliders +
all-cash toggle work live. `computed_roi` stays as the persisted default snapshot.

**The demo is the thesis, working:** all-cash → 17 green pins (best +$1,470/mo at
7115 Newbury Ave); financed → 0 pins with an honest empty-state hint.

**Bugs found & fixed during live browser verification (Chrome DevTools):**
1. Black map in screenshots — MapLibre paints on rAF (throttled in the automated
   tab); confirmed 17 pins actually rendered via `queryRenderedFeatures`.
2. Map container collapsed to 0 height — MapLibre forces `position:relative`,
   defeating Tailwind `absolute inset-0`; fixed with `h-full w-full`.
3. `preserveDrawingBuffer` moved under `canvasContextAttributes` in MapLibre v5.
4. `react-hooks/refs` lint — was reading/writing a ref during render; moved the
   filters-ref sync into a `useEffect`.

**Verification:** typecheck + eslint clean; `npm audit` 0; 132 tests (+pins-param
validation) / 11 skip offline. Live-verified: pins, gradient, $-labels, filters
(17⇄0), detail card, empty state.

**Deferred:** clustering (QA §15.I, when we add ZIPs); MapTiler/Protomaps vector
basemap (keyless OSM raster now); mobile bottom-sheet; Clerk auth.

---

## 2026-07-07 — Real heat map: dynamic color anchor + heat layer (audit fixes 1 & 2)

**Problem (audit):** every pin rendered the same green. Cause: the gradient was
keyed to fixed target multiples (T/1.5T/2T/3T) and the default target was $100, so
a market cash-flowing $434–$1,470 sat at 4–15× target — all clamped to the top
stop. The "heat map" showed no heat.

**Fix 1 — colour spreads across the viewport's own distribution.**
`interpolatePalette(t)` maps a normalised [0,1] position across the palette.
`queryPins` now computes a dynamic top anchor = max(2×target, p95(cash flows in
view)) and colours each pin by `(cf − target)/(topAnchor − target)`. Red = just
clears target; green = best in view. Returns `colorScale {target, mid, top}` so
the legend is labelled in DOLLARS (killed the "1.5T/2T" jargon). Default target
raised to $300. Pin radius now scales with cash flow (`heatWeight`), so magnitude
reads before colour. API-verified: 17 pins → **15 distinct colours** spanning
red-orange `#e56d4a` (+$434) → deep green `#006837` (+$1,470).

**Fix 2 — an actual heat layer.** Added a MapLibre `heatmap` layer under the
pins, weighted by `heatWeight`, fading out as you zoom in (heat at metro scale,
labelled pins up close), with a toggle. Ramp matches the pin palette.

**Tests:** +5 for `interpolatePalette`; 137 pass / 11 skip offline; typecheck +
eslint clean.

**Known env issue (not the code):** during live verification MapLibre's web
worker wedged in the automated Chrome session — a background-only throwaway map
also failed to load its style, and a fresh tab too, so it is environmental
(worker/session), not this change. The map rendered fine earlier today; the new
colour/scale logic is verified via the /api/pins response. Verify visually in a
normal browser (hard refresh / restart Chrome).

---

## 2026-07-07 — Sliders, first-run context, keyless basemap (audit fixes 3 & 4)

**Fix 3 — assumption sliders (decided for Phase 1, never shipped).** Added a
collapsible Assumptions panel: down payment, interest rate, loan term, vacancy,
management, maintenance + "reset to conservative defaults". Wired to the
already-parameterized API, debounced (350ms) so sliding/typing doesn't spam
requests. This answers the core investor question — API-verified: at 7% financed,
20–65% down still clears 0 pins at +$300/mo; all-cash clears 17 (the honest
crossover is ~75%+ down). Detail card now also shows **cash-on-cash, cap rate,
rent/price, cash invested** (all derivable from data we had) and a confidence
rationale line.

**Fix 4 — first-run context + honest empty states.** Added a one-line intro and
coverage note. The old empty-state falsely told users to "try all-cash" when the
truth was no data — now split on the API's `scanned`: `scanned=0` → "No coverage
here yet — we cover San Bernardino (92404)"; `scanned>0, count=0` → "N listings
checked, none clear +$X (with Y% down @ Z%)". Legend already dollar-labelled.
Esc closes the detail card.

**Basemap → CARTO Voyager (keyless).** Swapped off OSM's own tile server (its
usage policy forbids app/heavy use). MapTiler/Protomaps vector tiles remain the
production target.

**Verification:** typecheck + eslint + `npm audit` clean; 137 tests / 11 skip.
API-verified end to end. The control panel renders all the new UI (confirmed by
screenshot); the WebGL map canvas stayed black due to WebGL-context exhaustion in
the automated Chrome session (self-inflicted by ~6 throwaway debug maps; a
trivial background-only map fails too). Cleared by a browser restart — verify in
a fresh browser.
