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
- `lib/roi/` — pure ROI engine: `statistics`, `amortization`, `defaults`, `cashflow`, `confidence`, `color`, `afterTax`. Barrel: `lib/roi/index.ts`. Fully unit-tested (QA §15 A/B/C).
- `app/` — Next.js App Router (scaffold only so far).
