/**
 * Deal-quality scoring — a local spatial-outlier model for "how good is this
 * deal, really?" (brief §2: honest, conservative, traceable).
 *
 * Coloring pins by absolute cash flow is misleading: a $400k home and a $700k
 * home that both net $1,400/mo look identical, though the $400k one is a far
 * better use of capital. This module fixes that with two ideas from spatial
 * hot-spot analysis (Getis-Ord Gi* / LISA local Moran's I):
 *
 *   1. CAPITAL EFFICIENCY — cap rate (annual NOI ÷ price), financing-independent.
 *      Same return for less money ⇒ higher cap rate ⇒ better.
 *   2. LOCAL OUTLIER — how far this property's cap rate sits above its
 *      NEIGHBORHOOD's typical cap rate. A bargain among pricier peers is a
 *      "High-Low" outlier (the real find). A cluster of identical cheap units is
 *      a "High-High" cluster — the local norm, not special, and often a red flag
 *      (overbuilt complex or an inflated ZIP rent AVM).
 *
 * The output `dealScore` ∈ [0,1] drives pin color and heat weight; flags
 * (`cluster`, `belowMarket`) surface the "sketchy" cases for verification rather
 * than hiding them. Pure and deterministic — no I/O.
 */

import { median } from "./statistics";

export interface DealInput {
  id: string;
  lat: number;
  lng: number;
  price: number;
  /** Annual NOI ÷ price (financing-independent return on capital). */
  capRate: number;
}

export interface DealResult {
  capRate: number;
  /** Median cap rate of nearby listings — the local market baseline. */
  localMedianCapRate: number;
  /** (capRate − localMedian) / localMedian. >0 = beats its neighborhood. */
  relAdvantage: number;
  /** 0..1 composite: capital efficiency blended with local advantage. */
  dealScore: number;
  /** Part of a tight cluster of near-identical units (verify: complex/AVM artifact). */
  cluster: boolean;
  /** Priced well below the local median (verify: condition/distress). */
  belowMarket: boolean;
  /** Neighbors used for the local baseline. */
  neighborCount: number;
}

export interface DealConfig {
  /** Radius (miles) for the local baseline. */
  neighborRadiusMiles: number;
  /** Radius (miles) for the tight homogeneity/cluster check. */
  clusterRadiusMiles: number;
  /** Min near-identical neighbors to flag a cluster. */
  clusterMinCount: number;
  /** Price/cap similarity tolerance for "near-identical". */
  clusterTolerance: number;
  /**
   * Radius (miles) for "literally the same building/lot" — much tighter than
   * clusterRadiusMiles. ~0.02mi ≈ 100ft.
   */
  sameBuildingRadiusMiles: number;
  /** Min OTHER units at the same building to flag a cluster regardless of
   * price/cap spread (catches e.g. a micro-unit building where unit prices
   * vary a lot but all share one broken rent assumption). */
  sameBuildingMinCount: number;
  /** price < this × localMedianPrice ⇒ belowMarket flag. */
  belowMarketRatio: number;
  /** relAdvantage that maps to the top of the relative score. */
  relScale: number;
  /** Blend weight on absolute capital efficiency (rest goes to local advantage). */
  weightAbsolute: number;
  /** Score multiplier applied to flagged clusters (dampens false hot-spots). */
  clusterPenalty: number;
  /**
   * Cap rate above which the return is almost certainly a data artifact (a
   * broken rent basis, a fractional price, a mistyped sqft) rather than a real
   * turnkey yield. Beyond this the absolute-efficiency score is capped so an
   * out-of-distribution cap rate can't alone rocket a listing to dealScore≈1.
   */
  implausibleCapRate: number;
}

export const DEFAULT_DEAL_CONFIG: Readonly<DealConfig> = Object.freeze({
  neighborRadiusMiles: 3,
  clusterRadiusMiles: 0.5,
  clusterMinCount: 4,
  clusterTolerance: 0.1,
  sameBuildingRadiusMiles: 0.02,
  sameBuildingMinCount: 2,
  belowMarketRatio: 0.6,
  relScale: 0.4,
  weightAbsolute: 0.5,
  clusterPenalty: 0.65,
  // ~18% cap rate. A conservatively-underwritten LA rental almost never clears
  // this honestly; beyond it, treat the return as suspect, not exceptional.
  implausibleCapRate: 0.18,
});

/** Approx local distance in miles (fine at neighborhood scale). */
function milesBetween(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const dLat = (aLat - bLat) * 69.0;
  const dLng = (aLng - bLng) * 69.0 * Math.cos((aLat * Math.PI) / 180);
  return Math.hypot(dLat, dLng);
}

/**
 * Floor used when a cap rate sits at/near zero, so dividing by it doesn't blow
 * up or (worse) flip sign. 0.5 percentage points is small enough to not distort
 * a genuinely large cap rate, large enough to keep a near-zero denominator sane.
 */
const MIN_CAP_DENOM = 0.005;

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/**
 * Percentile rank (0..1) of `value` within `sorted` (ascending), using the
 * MIDRANK convention for ties so a market of identical cap rates maps every
 * item to the neutral 0.5 (matching the length<=1 guard) rather than 0 — a
 * min-rank would wrongly score a whole tied market as bottom-of-market.
 */
function percentileRank(sorted: number[], value: number): number {
  const nn = sorted.length;
  if (nn <= 1) return 0.5;
  let below = 0;
  let equal = 0;
  for (const v of sorted) {
    if (v < value) below++;
    else if (v === value) equal++;
    else break;
  }
  const rank = below + (equal > 0 ? (equal - 1) / 2 : 0);
  return rank / (nn - 1);
}

/**
 * Score a set of listings. `items` should be the full local market in view (not
 * just the ones that clear the user's target) so the baseline reflects reality.
 * Returns a result per item id.
 */
export function scoreDeals(
  items: readonly DealInput[],
  config: DealConfig = DEFAULT_DEAL_CONFIG,
): Map<string, DealResult> {
  const results = new Map<string, DealResult>();
  const capsSorted = items.map((i) => i.capRate).sort((a, b) => a - b);

  for (const it of items) {
    const neighborCaps: number[] = [];
    const neighborPrices: number[] = [];
    let clusterCount = 0;
    let sameBuildingCount = 0;
    const itCapDenom = Math.max(Math.abs(it.capRate), MIN_CAP_DENOM);

    for (const other of items) {
      if (other.id === it.id) continue;
      const d = milesBetween(it.lat, it.lng, other.lat, other.lng);
      if (d <= config.neighborRadiusMiles) {
        neighborCaps.push(other.capRate);
        neighborPrices.push(other.price);
      }
      if (
        d <= config.clusterRadiusMiles &&
        it.price > 0 &&
        Math.abs(other.price - it.price) / it.price <= config.clusterTolerance &&
        Math.abs(other.capRate - it.capRate) / itCapDenom <= config.clusterTolerance
      ) {
        clusterCount++;
      }
      // Literally the same building/lot, regardless of how much unit prices
      // vary — e.g. a micro-unit building where every unit shares one broken
      // rent assumption even though prices swing 15-30% between units.
      if (d <= config.sameBuildingRadiusMiles) sameBuildingCount++;
    }

    const localMedianCap = neighborCaps.length ? median(neighborCaps) : it.capRate;
    const localMedianPrice = neighborPrices.length ? median(neighborPrices) : it.price;
    // Divide by |localMedianCap| (never the signed value) so the SIGN of
    // relAdvantage always reflects whether `it` beats the local baseline, even
    // when that baseline is negative (realistic for expensive, high-tax,
    // low-rent properties) or exactly zero.
    const relAdvantage = (it.capRate - localMedianCap) / Math.max(Math.abs(localMedianCap), MIN_CAP_DENOM);

    // Absolute capital-efficiency score: percentile of cap rate across the market.
    // A cap rate past the plausibility ceiling is treated as suspect data, not a
    // top-of-market deal — cap the absolute score so it can't max out alone.
    const absScore =
      it.capRate > config.implausibleCapRate ? 0.5 : percentileRank(capsSorted, it.capRate);
    // Local-advantage score: relAdvantage mapped so 0 → 0.5, ±relScale → 1/0.
    const relScore = clamp01((relAdvantage + config.relScale) / (2 * config.relScale));

    let dealScore = config.weightAbsolute * absScore + (1 - config.weightAbsolute) * relScore;

    const cluster = clusterCount >= config.clusterMinCount || sameBuildingCount >= config.sameBuildingMinCount;
    if (cluster) dealScore *= config.clusterPenalty;
    // `belowMarket` (much cheaper than neighbours) is surfaced as a VERIFY flag,
    // not a score penalty: cheapness alone is exactly the capital-efficiency
    // edge this model rewards (a $400k home matching a $700k home's return
    // SHOULD read greener). The genuinely-broken cheap cases — micro-units,
    // multi-unit-priced-whole, implausible rent/sqft, fractional shares — are
    // demoted precisely where they're detected: forced Low+de-emphasis at
    // ingest (lib/ingest/compute.ts) which the pin ranking then honours
    // (lib/pins/query.ts qualityFactor). Penalising cheapness itself would
    // punish the good bargains along with the bad.
    const belowMarket = it.price < config.belowMarketRatio * localMedianPrice;

    results.set(it.id, {
      capRate: it.capRate,
      localMedianCapRate: localMedianCap,
      relAdvantage,
      dealScore: clamp01(dealScore),
      cluster,
      belowMarket,
      neighborCount: neighborCaps.length,
    });
  }

  return results;
}
