# ROI Guide

A public, mobile-responsive web app that lets a real-estate investor scan a city
and instantly see the **monthly cash-flow return** of available properties as
colour-coded map pins — filtered by budget and target return, with a
rent-supply / rent-reliability heatmap layered on top.

Its edge over incumbents is **honest, confidence-aware ROI**: every number is
conservative by default (median of comps, realistic reserves) and traceable to
the data behind it. See `CLAUDE.md` for the full product principles and
`DECISIONS.md` for the decision log.

> **Status:** Phase 1, early. The pure ROI engine (`lib/roi/`) is built and
> fully unit-tested. UI, API, database, auth, and data ingestion are not wired
> up yet.

## Requirements

- **Node 24 LTS** (this repo was built on 24.18.0) and npm.
- A PostgreSQL + PostGIS database and a Redis instance (Railway/Upstash) — only
  needed once the API/ingestion layers land.

## Setup

```bash
npm install
cp .env.example .env.local   # fill in real values; .env* is gitignored
```

Never commit secrets. Only the Clerk publishable key and Sentry DSN may be
public; all provider and database keys are server-side only (see `.env.example`).

## Run

```bash
npm run dev        # start the Next.js dev server (http://localhost:3000)
npm run build      # production build
npm start          # serve the production build
```

## Test & check

```bash
npm test           # Vitest unit/integration suite (run once)
npm run test:watch # Vitest in watch mode
npm run typecheck  # tsc --noEmit
npm run lint       # ESLint
```

## Project layout

```
lib/roi/           Pure, deterministic ROI engine (no I/O). Fully tested.
  statistics.ts    median / percentile / IQR / stdev / CV (median, never mean)
  amortization.ts  mortgage P&I (incl. 0%-rate and all-cash edge cases)
  defaults.ts      frozen conservative default assumptions
  cashflow.ts      monthly pre-tax cash flow + per-line provenance + flags
  confidence.ts    rent-confidence score (count / spread / recency)
  color.ts         continuous cash-flow → pin-colour gradient + legend
  afterTax.ts      rough depreciation-shield after-tax estimate (labelled)
app/               Next.js App Router (scaffold)
```

## Tech stack

TypeScript · Next.js 16 (App Router) · Tailwind 4 · MapLibre GL (planned) ·
PostgreSQL + PostGIS via Drizzle (planned) · Clerk auth (planned) · Redis ·
Zod · Vitest / Playwright / axe-core · Sentry. Full pinned list in `CLAUDE.md`.
