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
