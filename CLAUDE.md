@AGENTS.md

# ROI Guide — Project Rules (read at the start of every session)

Public, multi-user web app that shows a real-estate investor the monthly
cash-flow return of available properties as colour-coded map pins, filtered by
budget and target return, with a rent-supply / rent-reliability heatmap on top.
Core promise: **honest, confidence-aware ROI** — conservative by default, every
number traceable to the data behind it.

## Non-negotiable product principles (the reason this app exists)
1. **Never show a bare number.** Every rent/ROI expands to its comps, spread, and confidence rationale.
2. **Default conservative, never optimistic.** Median of comps (never mean); realistic vacancy/mgmt/maintenance reserves always applied. If it must err, it errs low.
3. **Confidence is a first-class feature.** Comp count, spread, recency → a published confidence score/range.
4. **Never silently guess a cost.** Missing HOA/tax/insurance is flagged and lowers confidence — never a silent optimistic $0.
5. **One outlier must never move an estimate.** Median + spread, not mean.
6. **The map is the product.** Uncluttered; single-property analysis is one click.
7. **Monetize honestly** (if monetized): clear trial, transparent pricing, one-click cancel, no dark patterns.

## Decisions locked (see DECISIONS.md for full log)
- Geography: **Greater Los Angeles** metro at launch.
- Data budget: **$100/mo** ceiling to start (RentCast backbone + ATTOM), with spend alerts.
- ROI: **pre-tax monthly cash flow** is the real number. One **rough, labelled after-tax** estimate (depreciation shield only — not tax advice).
- Mortgage: **fixed conservative defaults AND live sliders + all-cash toggle**, both in Phase 1.
- Rent basis: **median of comps** (radius 0.5→1 mi, 90-day window); RentCast AVM shown alongside as cross-check.
- Colour: **continuous gradient** keyed to cashFlow/target, anchored at T/1.5T/2T/3T; colourblind (viridis) toggle; direction is a single config flag.
- Exclusions: raw land, new construction, foreclosure, auction, pre-foreclosure, REO, pending, contingent, under-contract, off-market, coming-soon, 55+. Include SFH/condo/townhome/2–4 unit. 5+ unit multifamily deferred.

## Pinned stack (do not swap a core library without asking)
- **Runtime:** Node 24.18.0 LTS (installed userspace at `~/.local`), npm. Bun is available but Node is the standard for local == Railway prod parity.
- **Language:** TypeScript end to end.
- **Framework:** Next.js 16.2.10 (App Router). ⚠️ This Next has breaking changes vs. training data — read `node_modules/next/dist/docs/` before writing Next-specific code (see AGENTS.md).
- **Styling:** Tailwind 4 + a headless component kit (TBD when UI starts).
- **Map:** MapLibre GL JS + vector tiles (Protomaps/MapTiler).
- **DB:** PostgreSQL + PostGIS on Railway. **DB access:** Drizzle ORM + migrations; raw SQL through Drizzle for geospatial.
- **Auth:** Clerk (roles + sessions). Never hand-roll auth.
- **Cache/rate-limit:** Redis (Upstash/Railway).
- **Validation:** Zod at every boundary.
- **Ingestion:** n8n scheduled pulls; Apify fallback only; BullMQ if heavier processing needed.
- **Tests:** Vitest (unit/integration), Playwright (e2e), axe-core (a11y), in CI.
- **Errors:** Sentry, scrubbed of secrets/PII.
- **Security in CI:** Semgrep, npm audit, secret scanner, Dependabot.

## Security rules (OWASP-aligned, every item a gate — see brief §9)
- Secrets: server-side env only; `.env` gitignored; `.env.example` holds placeholders only; **never** a `NEXT_PUBLIC_` provider/DB/Clerk-secret key. Rotate on any exposure.
- All provider API calls go through the backend; the client never holds a provider key.
- Every non-public endpoint authenticated; HTTPS; CORS locked to our origins; rate-limit every endpoint via Redis.
- **Strict per-user isolation** (OWASP A01): verify ownership server-side on every request; test IDOR (changing an ID never reveals another user's data).
- Validate/sanitise every input with Zod; parameterised queries only (never string-concatenated SQL); sanitise output.
- Generic errors to users; stack traces server-side only; never log secrets/PII.
- Verify every package exists & is maintained before adding; pin versions; run `npm audit`; secret-scan before every push.
- **Self-review gate after each feature:** "does this leak secrets, can one user reach another's data, any OWASP Top 10 issue?" Fix before commit.

## Working loop (every unit of work)
Plan → confirm with owner → implement a small increment → self-review (bugs + security) → run tests → commit (small, atomic, descriptive) → update DECISIONS.md & CLAUDE.md → repeat. Finish a phase's Definition of Done (brief §16) before starting the next.

## Conventions
- Keep files small, one responsibility each. Favour many small well-named modules.
- Pure domain logic (the ROI engine, `lib/roi/*`) stays free of I/O, clock, and randomness so it is deterministic and testable.
- Commands: `npm run dev` · `npm run build` · `npm test` · `npm run typecheck` · `npm run lint`.

## Current architecture (update as it grows)
- `lib/roi/` — pure ROI engine: `statistics`, `amortization`, `defaults`, `cashflow`, `confidence`, `color`, `afterTax`, `deal` (local spatial-outlier deal-quality scoring — cap rate percentile + relative advantage vs. neighbors within 3mi, plus cluster detection: price/cap tolerance AND a same-building (~100ft) geometric check), `sizeSanity` (`isAtypicallySmall(sqft,bedrooms)` — flags units too small for our bedroom-matched rent basis to apply, forces Low confidence). Barrel: `lib/roi/index.ts`. Fully unit-tested (QA §15 A/B/C).
- `lib/providers/rentcast/` — **server-only** RentCast client: `client` (retry/backoff, cache-aware, Zod-validated; key from `process.env.RENTCAST_API_KEY`, never logged/in-URL), `schemas`, `errors`, `cache` (in-memory now, Redis later). Unit-tested with injected fetch (QA §15.G). Barrel: `index.ts`.
- `lib/hygiene/` — pure listing-hygiene screen (§6.C/§4.Q7): `tokens` (normalisation + allow/deny vocab), `screen` (`screenListing`/`screenListings` → render decision + coded reasons). Conservative allowlist, fail-closed, clock injected. Unit-tested (QA §15.D). Barrel: `index.ts`.
- `lib/ingest/` — ingestion pipeline (RentCast → hygiene → ROI → persist): `mapRentcast` + `compute` (pure, unit-tested), `persist` (idempotent upserts, explicit SRID geometry), `pipeline` (`ingestZip`, injectable client+db). Integration-tested live (QA §15.G) + a gated `live-run` (`RUN_LIVE_INGEST=1`, `INGEST_ZIP`). Phase-1 rent basis = ZIP bedroom-matched median (1 market call/zip, not per-property AVM). `computed_roi.color_band` stores the target-INDEPENDENT sign; render gradient is target-relative via `lib/roi/color`.
- `db/` — Drizzle schema + migrations. `schema/market.ts` (properties, listings, rent_comps, market_snapshots, computed_roi — PostGIS `geometry(Point,4326)` + GiST indexes), `schema/users.ts` (users, saved_searches, alerts — RLS-protected). `client.ts` (server-only pool + `withUser()` RLS scoping). `drizzle.config.ts`. Migration `0000_*.sql` hand-augmented with `CREATE EXTENSION postgis`, SRID 4326, and RLS (enable+FORCE+policies). Static-guarded by `db/migrations.test.ts` (QA §15.H/§15.M). Scripts: `db:generate/migrate/push/studio`.
- `lib/http/pinsParams.ts` — Zod validation for the pins/detail query strings (viewport, target, budget, assumption sliders). Unit-tested (§9 boundary validation).
- `lib/pins/query.ts` — **server-only** PostGIS pin query (GiST bbox, `order by confidence_score desc, price asc` before the 5000-row `SCAN_CAP`, exposes `scannedCapped`) + property-detail query. Recomputes cash flow per listing from the caller's assumptions via the ROI engine (makes sliders/all-cash live), colours by `scoreDeals` (deal quality, not raw cash flow) via `lib/roi/color`, assigns `rank` 1..N best-first within the response. `houseOnly` restricts to SFH/2-4-unit-MF with no known HOA. Detail re-runs the engine for the itemised breakdown + investor metrics (cash-on-cash/cap rate/rent-to-price).
- `lib/redis/client.ts`, `lib/ratelimit.ts` — ioredis client + fixed-window rate limiter (fail-open).
- `app/api/pins/route.ts`, `app/api/property/[id]/route.ts` — public read endpoints: rate-limited, Zod-validated (bbox capped at 10° span), generic errors. Return GeoJSON / detail JSON.
- `app/components/MapView.tsx` — client MapLibre map: pins coloured by deal-quality gradient, numbered rank badges (toggleable) + a heat layer, filter controls (target/budget/all-cash/houseOnly/colourblind/Night-mode), a collapsible rank-ordered property list (also the QA §15.K screen-reader list alternative), hover "sneak peek" popup, click→Zillow + detail card ("show the math"). Keyless CARTO raster basemap (Voyager/Dark Matter — swaps live via `setTiles`, guarded against the pre-load race). No clustering yet (one ZIP ≈ 20 pins).
- `app/page.tsx` — loads MapView with `next/dynamic` `ssr:false` (MapLibre is browser-only).

## Next.js 16 gotchas (this repo runs 16.2.10 — see AGENTS.md)
- **Async request APIs**: `params`, `searchParams`, `cookies`, `headers` are Promises — `await` them. Route handlers reading the request URL's query (`new URL(req.url).searchParams`) are sync/fine; dynamic-segment `params` (e.g. `[id]`) must be awaited.
- Turbopack is default; `next lint` is removed (use `eslint` directly — our `lint` script does); `serverRuntimeConfig`/`publicRuntimeConfig` removed (use `process.env`).
- `next/dynamic` with `ssr:false` only works in a Client Component (mark the page `"use client"`).
- MapLibre v5 nests WebGL attrs under `canvasContextAttributes` (e.g. `preserveDrawingBuffer`); it also forces `position:relative` on its container — size the map div with `h-full w-full`, not `absolute inset-0`.

## RLS contract (do not break)
User-owned tables (users, saved_searches, alerts) have RLS ENABLED + FORCED; policies match `user_id = current_setting('app.user_id', true)` (NULL when unset ⇒ zero rows, fail-closed). ALWAYS access user data via `withUser(userId, db => ...)` which sets `app.user_id` for the transaction. **The runtime MUST connect as the non-superuser `roi_app` role (`APP_DATABASE_URL`)** — superusers bypass RLS even when forced, so connecting as `postgres` would silently disable all isolation. Cross-user workers (n8n alert checker) must iterate per user setting `app.user_id`. Never disable FORCE; never point the runtime at the superuser URL. Verified live in `db/integration.test.ts` (QA §15.M).

## Env / provisioning status
- RentCast: account created, dev API key in `.env.local` (free "API Developer" tier, 50 calls/mo). Verified live (zip 90020: median $1,850 vs mean $2,124 — the skew we defeat).
- Railway project `romantic-tenderness`: **Postgres 18 + PostGIS 3.6** (image swapped to `postgis/postgis:18-3.6`) and **Redis**, both Online. Migration applied; schema verified live (SRID 4326, GiST, RLS enabled+forced). Connection strings in `.env.local`. ⚠️ Railway account is on a TRIAL — services pause when it lapses unless the owner upgrades (billing = owner's decision).
- Two DB roles: **`postgres`** (superuser) for MIGRATIONS ONLY (`DATABASE_URL`); **`roi_app`** (non-superuser, NOBYPASSRLS) for the RUNTIME (`APP_DATABASE_URL`) so RLS is actually enforced. Create/rotate `roi_app` with `scripts/setup-app-role.mjs`.
- Not yet provisioned: ATTOM, Clerk, Sentry.
