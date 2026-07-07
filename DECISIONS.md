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
