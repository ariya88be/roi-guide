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
  /** price < this × localMedianPrice ⇒ belowMarket flag. */
  belowMarketRatio: number;
  /** relAdvantage that maps to the top of the relative score. */
  relScale: number;
  /** Blend weight on absolute capital efficiency (rest goes to local advantage). */
  weightAbsolute: number;
  /** Score multiplier applied to flagged clusters (dampens false hot-spots). */
  clusterPenalty: number;
}

export const DEFAULT_DEAL_CONFIG: Readonly<DealConfig> = Object.freeze({
  neighborRadiusMiles: 3,
  clusterRadiusMiles: 0.5,
  clusterMinCount: 4,
  clusterTolerance: 0.1,
  belowMarketRatio: 0.6,
  relScale: 0.4,
  weightAbsolute: 0.5,
  clusterPenalty: 0.65,
});

/** Approx local distance in miles (fine at neighborhood scale). */
function milesBetween(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const dLat = (aLat - bLat) * 69.0;
  const dLng = (aLng - bLng) * 69.0 * Math.cos((aLat * Math.PI) / 180);
  return Math.hypot(dLat, dLng);
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/** Percentile rank (0..1) of `value` within `sorted` (ascending). */
function percentileRank(sorted: number[], value: number): number {
  if (sorted.length <= 1) return 0.5;
  let lo = 0;
  for (const v of sorted) {
    if (v < value) lo++;
    else break;
  }
  return lo / (sorted.length - 1);
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
        it.capRate !== 0 &&
        Math.abs(other.price - it.price) / it.price <= config.clusterTolerance &&
        Math.abs(other.capRate - it.capRate) / Math.abs(it.capRate) <= config.clusterTolerance
      ) {
        clusterCount++;
      }
    }

    const localMedianCap = neighborCaps.length ? median(neighborCaps) : it.capRate;
    const localMedianPrice = neighborPrices.length ? median(neighborPrices) : it.price;
    const relAdvantage = localMedianCap > 0 ? (it.capRate - localMedianCap) / localMedianCap : 0;

    // Absolute capital-efficiency score: percentile of cap rate across the market.
    const absScore = percentileRank(capsSorted, it.capRate);
    // Local-advantage score: relAdvantage mapped so 0 → 0.5, ±relScale → 1/0.
    const relScore = clamp01((relAdvantage + config.relScale) / (2 * config.relScale));

    let dealScore = config.weightAbsolute * absScore + (1 - config.weightAbsolute) * relScore;

    const cluster = clusterCount >= config.clusterMinCount;
    if (cluster) dealScore *= config.clusterPenalty;
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
