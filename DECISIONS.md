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

---

## 2026-07-08 — Westside/Malibu/Calabasas ingest saga, ranked list, night-mode fixes, full review + honesty fixes

**Ingest iteration (owner rapidly refined scope):** 50mi/$700k -> 50mi/$1M ->
10mi/$1M -> 25mi/$1M/houses-only, all centered on West Hollywood (34.09,
-118.3617). Three of these (10mi/25mi/50mi at $1M) were run as CONCURRENT
background processes against the same DB and RentCast key — a first real test
of the idempotent-upsert design under actual concurrency. Added
`getCachedOrLiveMarket()` (market_snapshots gets a `data_by_bedrooms` jsonb
column, migration 0002) so re-running/continuing over overlapping geography
reuses already-fetched ZIP rent data instead of re-paying for it.

**Result:** 3,851 total properties, 1,588 house-only (SFH/2-4-unit MF, no known
HOA) <=$1M. Zero duplicate rows from the concurrency (verified: zero duplicate
rentcast_id / listing property_id+source / computed_roi.listing_id / snapshot
zip+date groups; 2,975 of 3,851 properties were genuinely touched by more than
one run, proving real collisions were absorbed cleanly by `ON CONFLICT DO
UPDATE`). 1566 Haslam Ter ($895k) now correctly appears under the $1M cap; 8248
Mannix Dr ($1.08M) correctly stays excluded — both mysteries the owner asked
about resolved with concrete RentCast data, not guesses.

**New UI (owner request): ranked numbered pins + expandable list.**
`queryPins` now assigns `rank` 1..N (best-deal-first) to every feature in the
viewport response; `MapView`'s `pins-label` layer shows the bold rank badge at
ALL zoom levels (primary UI, not just a heat blur), with a secondary grey
cap-rate% sub-label once zoomed in. Clicking a pin OR a list row opens the
Zillow listing (in a new tab) AND the detail card — both paths now share one
`selectProperty` callback so they can't drift apart. A hover popup (MapLibre
Popup, NOT a Zillow iframe — Zillow blocks that and we don't scrape) gives a
quick peek built from our own data. A collapsible "Properties (N)" list under
the panel shows every current pin in rank order, scrollable — this doubles as
the QA §15.K "results-list alternative for screen readers" the brief requires.
Added a "Rating numbers on pins" toggle (show/hide the rank badge only).

**Comprehensive review workflow (owner: "study and review everything... make
sure all is executed well").** Ran a 4-dimension parallel review (concurrency/
data-integrity, map+API code correctness, ROI-engine/hygiene/RLS regression
check, live product smoke test) + a synthesis pass. Confirmed healthy: RLS
enforcement (roi_app genuinely non-superuser, verified live against pg_roles),
zero regressions in the untouched foundational modules, 155+ tests green,
hover-popup escapeHtml usage correct (no XSS), typecheck/lint clean, and — the
headline finding — the three concurrent ingests caused zero data corruption.

**Real bugs found and fixed:**
1. **[HIGH] `deal.ts` relAdvantage sign bug.** `localMedianCap > 0 ? ... : 0`
   silently zeroed the local-outlier signal whenever the local median cap rate
   was <=0 — realistic once prices climbed into $1M+ territory (property tax +
   insurance on a big price can exceed modest rent even before a mortgage,
   giving a negative NOI/cap rate). Naively removing the guard would have
   flipped the SIGN (dividing by a negative number). Fixed by dividing by
   `Math.max(Math.abs(localMedianCap), 0.005)` instead — preserves the correct
   sign whether the baseline is positive, negative, or ~zero. Same epsilon-floor
   fix applied to the cluster tolerance check (previously excluded any
   `capRate === 0` property from ever being compared).
2. **[HIGH] `query.ts` SCAN_CAP (5000) had no ORDER BY** — once a viewport
   exceeds it, Postgres returns an arbitrary subset and `scanned` silently
   misrepresents the true count. Added `order by confidence_score desc, price
   asc` (truncation now keeps the more-reliable, cheaper subset, not an
   arbitrary one) and a new `scannedCapped` response field so the client can
   honestly say "there may be more" instead of implying an exact total.
3. **[MEDIUM] `pinsParams.ts` had no bbox max-span check** — a whole-planet
   request (`-180,-90,180,90`) parsed successfully, which combined with the
   SCAN_CAP bug was a real cost-amplification vector. Capped span at 10°.
4. **[MEDIUM] Night-mode tile swap could silently no-op** if toggled before the
   map's initial style finished loading (`getSource('carto')` returns
   undefined pre-load). Fixed: apply immediately if `isStyleLoaded()`, else
   queue via `map.once('load', apply)`.
5. **[LOW] mode/budget validation gap** — an explicit `?mode=budget_return`
   with no `budget` silently behaved like an unlimited budget. `mode` is now
   ALWAYS derived from budget presence, never taken from a possibly-conflicting
   explicit param.

**The Beverly Glen investigation (found while verifying the new list feature,
not part of the workflow review) — the most concrete honesty bug of the
session.** Three units at 1333 S Beverly Glen Blvd (207-266 sqft "1BR condos")
were ranked #1, #2, #3 in a West Hollywood viewport at ~44-58% cap rates
($50k-75k price, $2,379-2,413/mo rent). Root cause: our Phase-1 rent basis
matches bedroom count only, so a 207 sqft micro-unit gets the SAME 1BR ZIP-
median rent ($3,499) as a normal ~800 sqft 1BR — the assumption clearly does
not apply. `belowMarket` correctly flagged them; `cluster` did NOT, because the
three units' prices vary 15-30% from each other (same building, different tiny
sizes) — outside the 10% price+capRate tolerance the cluster check used.

Fixed with two complementary changes:
- `deal.ts`: added a `sameBuildingRadiusMiles` (~100ft) geometric check —
  2+ OTHER units within ~100ft flags a cluster regardless of price/cap
  variance, directly catching "one building, many broken-rent units."
- New `lib/roi/sizeSanity.ts` (pure, tested): `isAtypicallySmall(sqft,
  bedrooms)` against a lenient per-bedroom floor (400 sqft for 1BR, etc.).
  Wired into `lib/ingest/compute.ts`'s `computeListingRoi` — an atypically
  small unit forces confidence to Low + de-emphasize, REGARDLESS of ZIP comp
  count, since the comps aren't for units like this one.
- **Backfilled the 15 already-ingested atypically-small rows** (incl. all 3
  Beverly Glen units) directly via SQL, since the fix only applies to future
  ingests otherwise and the owner was looking at this exact live data.

**After the fix (live-verified):** the 3 units dropped from rank 1-3
(dealScore 0.97-1.00) to rank 6-8 (dealScore 0.63-0.65), now showing
`cluster=true`, `confidence=Low(20)`, `deEmphasize=true` — four independent
honesty signals converging. They are not hidden (still real, still clear the
target) — per the product's "flag, don't hide" philosophy, the detail card
surfaces the cluster/belowMarket warnings for anyone who clicks in.

**Tests:** deal.ts +6 (relAdvantage sign regression x3, same-building cluster
regression x2), sizeSanity.ts (new file) +9, pinsParams.ts +2 (mode-derivation,
bbox-span). 168 pass / 3 skip with DB access; typecheck+lint clean throughout.

---

## 2026-07-07 — Rank-prefix cleanup, native pin clustering, per-property hide

**What:** Three UI requests, plus one real bug found and fixed along the way.

1. **Removed the "Rank N:" text prefix** from each Properties-list row — the
   rank is already shown in the colour-coded numbered bubble to its left, so
   the text was redundant. The row now leads with the address; the rank
   context moves into the button's `aria-label` so screen-reader users don't
   lose it (list still doubles as the §15.K map alternative).

2. **Native MapLibre clustering on the "pins" source** (`cluster: true`,
   `clusterMaxZoom: 14`, `clusterRadius: 60`) — at low zoom, dense areas were
   rendering as numbered pins stacked directly on top of each other with no
   way to tell them apart. Clusters now render as a bubble sized by point
   count and coloured by the cluster's AVERAGE deal score (`sum_score /
   point_count`, aggregated via `clusterProperties`, same red→green ramp as
   individual pins) — clicking one zooms in just enough to break it apart
   (`getClusterExpansionZoom` + `easeTo`). The existing `pins-circle` /
   `pins-label` / `pins-label-roi` layers got `filter: ["!", ["has",
   "point_count"]]` so they only draw unclustered individual points; the heat
   layer's `heatmap-weight` falls back to an aggregated `sum_heat` for cluster
   points so the glow doesn't blank out at low zoom.

3. **Per-property hide/show (eye icon)** in the Properties list — an eye
   icon on each row calls `toggleHidden(id)`. Hidden properties are removed
   from the MAP entirely (not shown, don't count toward clusters — that's the
   actual decluttering value), but stay in place in the LIST at their
   original position: the row shows a grey, blank (no-number) bubble and
   "Hidden" text instead of disappearing or moving to a separate section, and
   every row after it compresses its rank number upward by one to fill the
   gap — e.g. hiding rank 2 turns rank 3 into rank 2. This was a deliberate
   correction mid-implementation: the first pass moved hidden rows to a
   separate "Hidden" section at the bottom, which the owner explicitly did not
   want — the row's LIST POSITION should stay fixed, only its bubble/number
   should go blank.

**Bug found and fixed while wiring clustering (pre-dates this session's
changes):** `pins-circle`'s `circle-radius` expression nested a zoom-based
`interpolate` inside a `*` multiplication —
`["*", ["interpolate", ["linear"], ["zoom"], ...], heatWeightMultiplier]`.
MapLibre's style spec forbids a `zoom` expression from appearing anywhere
except as the direct input to a TOP-LEVEL `interpolate`/`step` — nesting it
inside `*` throws `"zoom" expression may only be used as input to a top-level
"step" or "interpolate" expression` at `addLayer` time. Because this threw
synchronously inside the map's `"load"` handler, EVERY line after it in that
handler silently never ran — including the initial `fetchPins()` call — so
every individual (unclustered) pin has been rendering as a bare floating
number with no coloured circle behind it, and the map never auto-loaded
listings on first paint, this whole project, undetected until now. Fixed by
switching to MapLibre's documented "zoom-and-property" composite pattern: a
nested `interpolate` (on `heatWeight`) inside each zoom stop's output, e.g.
`5, ["interpolate", ["linear"], ["get","heatWeight"], 0, 6.8, 1, 10.8]` — zoom
stays the sole top-level input, and the per-stop nested interpolate provides
the deal-quality-driven size variation. Live-verified: individual pins now
render as coloured circles, clusters render as bubbles, `Properties (N)` /
"N of M listings" reflect a real completed fetch, and clicking a cluster
correctly calls `getClusterExpansionZoom` and zooms in.

**Tests:** typecheck + lint clean; 158 pass / 13 skip offline, 168 pass / 3
skip with DB access — no regressions. Live-verified in the browser: rank
prefix removed, clusters colour/count correctly, cluster click zooms in and
breaks the cluster apart, hide/show toggles the map pin and compresses/
restores list rank numbers correctly.

---

## 2026-07-08 — Turnkey-rental thesis: fractional exclusion, quality-aware ranking, full validation audit, new map UI

Owner sharpened the mission: **surface only turnkey homes you can buy and rent
out immediately** — exclude fractional/co-ownership, raw land/unbuilt, and
distressed/"breaking down" homes; never reward a home that is cheap *because*
it is broken or fractional. Then asked to "validate everything from the start."

**The Malibu price bug → fractional ownership.** Owner flagged 20460 Pacific
Coast Hwy, Malibu showing ~$674k when it's "actually a lot more." Root cause:
it's a **Pacaso** listing — the price buys a **1/8 ownership share**, not the
whole home, so our engine underwrote a fractional price as a fee-simple sale
(Unit 2 showed a bogus +$1,015/mo). RentCast exposes `listingOffice`/
`listingAgent` (name/email/website); "Pacaso Inc." / mls@pacaso.com is
unambiguous. Fix: new hygiene exclusion `checkFractionalOwnership` (brand
tokens `pacaso`, `kocomo`, matched across all six office/agent name/website/
email fields; substring-safe brands only — `ember` deliberately omitted, it's
inside "September"). Live-deactivated the 2 in-DB offenders (is_active=false;
14 legit Malibu listings still render). Land was already excluded (0 land rows
in DB). **Distress is undetectable from structured data** — RentCast returns
`listing_type="Standard"` for everything, no condition/remarks field — so the
best available proxy is the implausible-rent/size gate + the belowMarket verify
flag; ATTOM/MLS remarks noted as the real condition source (follow-up).

**Full validation workflow** (5-dimension audit — data quality, ROI engine,
hygiene/pipeline, frontend/API, thesis alignment — each finding adversarially
verified by an independent refuter): 25 confirmed defects (2 critical, 7 high,
12 medium, 4 low), 5 false alarms rejected (incl. re-confirming the
circle-radius fix is genuine and the popup path is XSS-safe). Fixes landed:

1. **[CRITICAL] Quality-aware ranking.** Ranking sorted purely by cap-rate
   `dealScore`; `confidence`/`de_emphasize`/`belowMarket` were display-only, so
   cheap-because-broken/mis-priced homes surfaced at the top (de-emphasised pins
   only dimmed to 0.65 opacity while keeping rank #1). Fix: `lib/pins/query.ts`
   now multiplies the score that drives colour+heat+rank+label by a
   `qualityFactor` (×0.5 de-emphasise, ×0.75 Low confidence). Live-verified: top
   12 in a busy viewport are all clean turnkey homes; first de-emphasised pin
   sinks to rank 22.
2. **[HIGH] Multi-Family priced whole but rented as one door.** 453 MF rows had
   a single-unit ZIP median rent vs the whole-building price → wildly wrong
   (often −$40k/mo) ROI. `compute.ts` now forces Low+de-emphasise for
   multi-unit types (they can't be priced per-door in Phase 1); 376 active rows
   backfilled. They sink via the ranking fix; a per-door rent basis is the
   real fix (follow-up).
3. **[HIGH] Implausible rent/size.** A 440 sqft studio was handed the ZIP's
   $6,000 overall median (~$13.6/sqft vs a ~$3.5 norm). New
   `isImplausibleRentForSize` (uses the market snapshot's median rent-per-sqft)
   forces Low+de-emphasise; also a `implausibleCapRate` (18%) ceiling caps the
   absolute-efficiency score so an out-of-distribution cap rate can't reach
   ≈1. 2 active rows backfilled.
4. **[HIGH] averageRent silently stored as "medianRent"** when a bedroom
   segment lacked a median (`mapRentcast.ts`) — dropped; median-only, else fall
   through to the ZIP median. **Non-bedroom-matched fallback** (~52% of rows)
   now caps confidence at Low.
5. **[CRITICAL] Stale rows never deactivated.** Re-ingest skipped hygiene
   failures with `continue`, so a row ingested before a new exclusion existed
   kept `is_active=true` forever. New `deactivateListingByRentcastId` runs on
   any fetched-but-now-failing listing (the durable fractional fix; full
   not-seen feed reconciliation noted as follow-up).
6. **Correctness cluster:** fetch in-flight guard (out-of-order responses can't
   clobber newer pins); `/api/property/[id]` uses `safeParse` → 400 not 500 on
   a bad slider value; the "N of M clear your target" denominator now uses an
   honest `eligible` count (post price>0 + houseOnly) not the raw scan; and
   `percentileRank` uses the midrank convention so an all-tied market scores
   the neutral 0.5, not 0.

**Deliberate NON-fix:** `belowMarket` is kept a VERIFY flag, not a score
penalty. Penalising cheapness contradicts the owner's earlier explicit design
(a $400k home matching a $700k home's return should read *greener* — capital
efficiency is the edge we reward). The genuinely-broken cheap cases are
demoted precisely where detected (multi-family / micro-unit / implausible rent
→ Low+de-emphasise → ranking penalty), so cheapness itself needn't be punished.

**Default view:** opens on the **Hollywood Hills at zoom 9** (wide LA-metro
overview); stale "Inland Empire" copy corrected to the true coverage
(coast → city → San Fernando Valley → Inland Empire).

**New map UI (owner request):**
- **Cluster toggle** ("Group into graded clusters", on by default) via
  `GeoJSONSource.setClusterOptions({cluster})` — off shows every property as
  its own pin (preserves the `clusterProperties` set at creation).
- **Clusters graded, not counted.** First shipped as absolute A–F bands (a
  `step` on avg deal score); the owner then asked for an **ordinal A+…Z-**
  ranking — 26 letters × {+,·,−} = 78 unique grades, the best cluster in view is
  A+, the next A, then A-, … one grade each, with Z- the only grade allowed to
  repeat (surplus past 78 clusters). An ordinal rank can't be expressed in a
  MapLibre expression, and feature-state can't drive a layout `text-field`, so
  grades are rendered as lightweight HTML markers over the bubbles: on every
  `idle` the clusters in view are queried (`querySourceFeatures`, deduped by
  `cluster_id`), ranked by avg deal score, and labelled by index; markers clear
  on `zoomstart` (clusters merge/split) and the bubble COLOUR still shows
  absolute quality. `pointer-events:none` so a click still falls through to the
  GL cluster layer's zoom-in.
- **Teardrop map-pins**: an SDF teardrop (`makePinImage` → `addImage(sdf:true)`)
  tinted per-feature by the deal-quality colour (`icon-color`), rank number in
  the head, tip on the coordinate — replaces the plain circle. Same red→green
  ranking colour as the list bubbles. Hover/click hit-testing re-wired to the
  new `pins-symbol` layer and live-verified (sneak-peek popup + detail).

**Tests:** typecheck + lint clean; 176 pass / 13 skip offline, 186 pass / 3
skip with DB access (+18 new: fractional field coverage, multi-family /
implausible-rent / bedroom-fallback confidence, rent-per-sqft gate, cap-rate
ceiling, midrank). All map UI live-verified in the browser (graded clusters,
cluster toggle, coloured teardrops with rank numbers, hover preview).

**Note — dev-only gotcha:** heavy successive edits to `MapView.tsx` put
Turbopack's HMR into a stale/torn-down state twice (the map's `load` handler
appeared to fail with the *old* circle-radius error, or the map lost its
style). Both times a clean `rm -rf .next` + dev-server restart fixed it — it
was never a code defect (the served bundle was stale). Worth a hard restart
before trusting a "broken map" during a long editing session.

**Post-review round** (a second adversarial workflow reviewed the whole diff;
it rejected 4 "findings" as the intentional decisions above and confirmed 4
real ones, all fixed):
- **[MED] rent/sqft gate was inert on the cached ingest path.**
  `market_snapshots` didn't store `median_rent_per_square_foot`, so
  `getCachedOrLiveMarket` handed the gate `null` on every cache HIT (the common
  `ingestRadius` path) — `isImplausibleRentForSize` silently no-op'd. Added the
  column (migration `0003_closed_blur.sql`), persisted it in
  `upsertMarketSnapshot`, and reconstructed it on cache read. The gate now fires
  on both paths.
- **[MED] heatmap drew over the cluster bubbles/grades** (added after the
  cluster layers). `map.moveLayer("pins-heat", "clusters-circle")` drops the
  glow below the clusters so the grades stay legible at the default zoom.
- **[LOW] teardrop tip floated ~3px above the coordinate** — `makePinImage`
  canvas height was `22*scale`; the path's visible span is 20 units, so
  `20*scale` puts the tip exactly on the bottom edge (and the coordinate).
- **[LOW] reactivation left a stale `removed_date`** — `upsertListing` now
  clears it when a listing comes back active.

---

## 2026-07-08 (later) — Map/UX batch: shadow pins, deal-quality heatmap, budget range, profit/revenue, price-history sparkline

Eight owner-requested changes, all live-verified and adversarially reviewed (a
3-dimension workflow: backend / frontend-MapLibre / data-integrity, each finding
refuted independently — 5 confirmed low/med issues fixed below, the rest
rejected as intentional).

1. **Pin drop-shadow, not a white outline.** A second SDF teardrop layer
   (`pins-shadow`, translucent black, `icon-offset [3,3]`, halo-blur) under
   `pins-symbol`; the white `icon-halo` is gone. Reads as depth in day mode;
   on the dark basemap the shadow is naturally invisible and the pin's colour
   carries contrast (kept per the owner's explicit "shadow not outline").
2. **Deal-quality heatmap, gated.** Replaced the single density-coloured glow
   with TWO diverging heatmap layers — `pins-heat-good` (green) / `pins-heat-bad`
   (red) — weighted by how far each point sits above/below dealScore 0.5 (clusters
   aggregate `sum_good`/`sum_bad`). Only shown when the toggle is on AND **>=4
   homes are in frame** (counted in the idle handler: homes-in-clusters +
   unclustered singles), so a lone pin never glows. Both layers sit below the
   clusters.
3. Control panel **~20% more transparent** (`bg-white/95`→`/75`, dark `/90`→`/70`).
4. House-only helper text → `(no: HOA/condo/apt/manufactured)`.
5. **Budget is now a range** (min + max, default **$45k–$500k**). `Filters.budget`
   → `budgetMin`/`budgetMax`; parsed in `pinsParams`; the range is applied in
   `query.ts` **in JS, not SQL**, so `scanned` stays budget-independent (lets the
   UI distinguish a real coverage gap from "nothing in your price range").
6. **Profit / Revenue toggle.** `Filters.basis`: profit = net monthly cash flow
   (the default), revenue = gross monthly rent. The target filters on the chosen
   quantity; the label, fine print (lists every deduction), list value, aria
   label, hover popup, and `band` all track the basis.
7. **Em-dashes removed** from the control-panel copy.
8. **Price-history sparkline.** RentCast already returns each listing's price
   `history` in the sale payload — captured via `extractPriceHistory` into a new
   `listings.price_history` jsonb (migration 0004), returned by the pins API, and
   drawn as a minimal `<Sparkline>` line in each list row (>=2 points; green up /
   red down). No synthetic data — the line is null (nothing drawn) until real
   history exists. Backfilled the existing rows with two idempotent re-ingests
   (westside 50mi + Inland Empire radius); ~281 active listings now have a
   drawable multi-point history, the rest populate on the normal ingest cadence.

**Review fixes applied before deploy:** revenue-mode empty-state no longer
suggests financing/All-cash (gross rent is financing-independent) and now
mentions the budget; the budget range applied in JS so a too-narrow/empty
price band reads as "none in your price range", not a false "no coverage"; the
hover popup switches to gross rent in revenue mode; `band` compares the
basis-appropriate value against the target. Left as-is by design: no
`budgetMin<=budgetMax` guard (an inverted range honestly returns nothing), and
the shadow-over-outline trade in night mode (the owner's explicit choice).

**Tests:** typecheck + lint clean; 190 pass / 3 skip offline, 190+ with DB
(+4 `extractPriceHistory`, budget-range/basis param tests updated). All eight
live-verified in the browser (incl. the Sherman Oaks 749k→395k sparkline and
the profit↔revenue number switch).

---

## 2026-07-08 (later still) — Pin polish follow-ups, star feature, and a real rank-parity bug caught by review

Further owner-requested tweaks on top of the map/UX batch above, each live-verified,
plus a full adversarial re-review of the whole round before considering it done.

**Quick fixes:** removed the faint square artifact under each pin (the SDF
drop-shadow's `icon-halo-blur` had nowhere to fade before hitting the source
texture's edge — since the texture has zero padding, removing the halo
entirely was simpler and lower-risk than padding the canvas); rank number
**centering root-cause fix**: `pins-label` used `text-anchor: "bottom"` (text's
BOTTOM edge sits at the offset point, glyph extends upward from there) while
the offset formula assumed `"center"` semantics (glyph's own center at the
point) — verified the mismatch empirically with live `setLayoutProperty`
experiments (not just re-deriving the formula) before fixing; changed anchor
to `"center"`, kept the original formula unchanged. Cluster ring's white
stroke removed. Cap-rate sub-label halo thinned 50%. Pin opacity −20%
(1/0.7 → 0.8/0.45). "ROI Guide" → "LA ROI Guide" (title + `<h1>`). Eye/star
icons −25% (14px → 10.5px). Attribution "i" toggle removed
(`attributionControl:false`); OSM/CARTO credit shown as plain small text
instead — **then corrected to real `<a>` links** after review flagged that
CARTO/OSM's attribution terms expect an actual hyperlink, not just visible
text. "made by ariya" credit → a real MapLibre `IControl` (not an
absolutely-positioned React element) added right after `NavigationControl`,
specifically so it stacks directly under the zoom +/- buttons using
MapLibre's own control-group layout instead of guessing pixel offsets against it.

**New feature: star a property to keep comparing it across pans.** Star icon
under the eye icon per list row (grey outline → filled yellow); a starred
property that pans out of frame stays in the Properties list AND gets a
standalone yellow ★ marker on the map at its real coordinate (steps aside once
the property is back in frame, since the normal numbered pin already covers
it there). Hiding a property un-stars it; hidden rows have no star option.

**Adversarial review caught two real bugs from the first pass, both fixed:**
1. **Rank-parity break (high):** the first cut interleaved starred-but-out-
   of-frame properties into the SAME 1..N ranked sequence as the map's pins,
   so on-screen properties could show a different number in the list than on
   their own map pin — breaking both the "same rank order as the pins" promise
   and the QA §15.K screen-reader parity. Fixed by never interleaving:
   `listRows` numbers 1..N over `pinList` ONLY (identical to `visibleRanked`,
   guaranteed to always match the map), and starred-but-out-of-frame items get
   their own **"Starred, not in current view"** section with NO rank number
   (a number there would falsely claim to mean the same thing as "N on
   screen"). This also fixed a related medium finding — the header count and
   an empty "No coverage" message could contradict each other when the only
   list entry was an out-of-frame star; the header now reads
   "Properties (N · K starred elsewhere)" so the two counts never look like
   they disagree.
2. **Stale ROI data (high):** the starred-property snapshot was only ever
   captured at star-time, with no refresh — so if you changed the target/
   budget/financing sliders after starring, an out-of-frame starred property
   kept showing its OLD pre-change cash flow/price/colour indefinitely (the
   doc comment claimed it auto-refreshed; it didn't). Fixed: every
   `fetchPins` response now refreshes the cached snapshot for any starred
   property that's currently in the fetched viewport (via a `starredIdsRef`
   read inside the fetch callback, not a `setState`-in-`useEffect`, which
   `react-hooks/set-state-in-effect` correctly flagged on the first attempt).
   A property only goes stale once it *actually* pans out of frame, which is
   the accepted tradeoff the feature exists for.

**Also fixed from the same review pass:** `starredFeatures` cache now deletes
an entry on unstar (was unbounded growth for the session); eye/star buttons'
vertical padding bumped back up slightly (two stacked 10.5px icons had
shrunk the tap target notably) without changing icon size. **Left as
accepted, documented limitations:** a starred property that's later
delisted/sold has no server-side existence check and persists as a "starred,
not in current view" ghost until manually unstarred (session-scoped, self-
corrects on reload); the pin opacity (−20%) and icon size (−25%) reductions
were direct, explicit owner requests and were not walked back despite a
reviewer note that they marginally dilute the viridis colourblind palette's
fidelity — color was never the only signal there (rank number + $ figure are
unaffected, full-opacity, and always shown).

**Tests:** typecheck + lint clean; 190 pass / 3 skip offline+DB (unchanged —
this round is UI/state logic without new pure-function surface). Everything
above live-verified in the browser, including the specific repro that caught
the rank-parity bug (star a property, pan until only a different property is
on screen, compare its map-pin rank number against its list badge).

---

## 2026-07-08 (evening) — Mobile-responsive control panel

Owner: "when you open on your phone all you see is 'LA ROI Guide'. when you
click it, it expands... when you click it again it shrinks."

Below Tailwind's `md:` breakpoint (768px) the left panel now defaults to
collapsed — just the title bar (+ day/night toggle + a chevron), spanning
near-full width with small side margins so it reads as a mobile header, not a
floating desktop card. Tapping the bar (anywhere except the day/night button,
which stops propagation) toggles a `panelExpanded` state; the panel body is a
single wrapping `<div>` around everything below the header, switched via
`hidden` / `block` by that state. At `md:` and up the body carries a
`md:block` override that ALWAYS shows it regardless of `panelExpanded` — so
desktop behaviour is completely unchanged (verified at a genuine 1440px
width; the tool's own "desktop" preset turned out to resolve to 706px in
this environment, usefully catching that the naive test would have hidden a
real bug). Expanded-on-mobile is height-capped
(`max-h-[calc(100vh-1rem)] overflow-y-auto`) so it never exceeds the
viewport on a short phone screen.

**Tests:** typecheck + lint clean; 190 pass offline+DB. Live-verified at
375×812 (mobile: collapsed by default, expands/collapses on tap, confirmed
via the accessibility tree that a collapsed panel is truly removed — `hidden`,
not just visually dimmed) and 1440×900 (desktop: always fully expanded,
identical to pre-change behaviour).

---

## 2026-07-08 (night) — Fix: number inputs unreadable in light mode on a dark-OS device

Owner: entered numbers were very light/hard to read in the app's own "day"
mode, but fine in "night" mode.

Root cause: `app/globals.css` had a leftover `@media (prefers-color-scheme:
dark)` block (default Next.js scaffold boilerplate) that overrode
`--foreground` to a near-white colour whenever the user's OS itself is in
dark mode — completely independent of the app's own explicit `.dark`-class
Night-mode toggle (`@custom-variant dark (&:where(.dark, .dark *))`, per the
comment directly above it). On a device with the OS set to dark, picking
"Day mode" in-app made the panel/inputs go light-background as expected, but
`body`'s base text colour stayed near-white (driven by the OS, not the
in-app toggle) — light text on a light background. Removed the media query
block entirely; `--foreground` is now always the single light-mode value,
exclusively overridden by the app's own `.dark` class where used.

Also added an explicit `text-gray-900` (paired with the existing
`dark:text-gray-100`) to all four themed inputs (target, budget min/max, and
one other) that were relying on inherited body colour rather than an
explicit light-mode class — defense in depth, matching the pattern already
used everywhere else in this file (never rely on inherited/ambient colour
for themed text).

**Tests:** typecheck + lint clean; 190 pass. Live-verified by emulating an
OS-dark-scheme browser, forcing in-app Day mode, and reading each input's
*computed* text colour (decoded via an offscreen canvas to confirm the true
resolved RGB, not just trusting the CSS source) — all three price/target
inputs render `rgb(16,24,40)` (dark, readable) in day mode and
`rgb(243,244,246)` (light, readable) in night mode.
