/**
 * Rent-confidence scoring — the product's core differentiator (brief 6.D).
 *
 * Confidence is a first-class number derived from three transparent signals:
 *   1. comp count in radius   — more comps  -> higher confidence
 *   2. spread of the comps     — tighter set -> higher confidence
 *   3. recency of the comps    — newer leases -> higher confidence
 *
 * A thin comp set (below the configured minimum) is FORCED to "Low" and flagged
 * for visual de-emphasis, no matter how tight or recent — because a tiny sample
 * cannot be trusted (QA 15.B). The score never inflates a shaky estimate.
 *
 * Pure module. Recency is expressed as comp AGE IN DAYS supplied by the caller,
 * so no clock lives here (keeps it deterministic and testable).
 */

import { coefficientOfVariation, median } from "./statistics";
import { CONSERVATIVE_DEFAULTS } from "./defaults";

/** A comparable rental used to estimate rent. */
export interface RentComp {
  /** Monthly rent in dollars. */
  rent: number;
  /** Age of the comp in days (0 = leased/listed today). */
  ageDays: number;
}

export type ConfidenceLevel = "Low" | "Medium" | "High";

export interface ConfidenceResult {
  /** 0..100. Higher = more trustworthy rent estimate. */
  score: number;
  level: ConfidenceLevel;
  /** True when the pin must be visually de-emphasised (dim / dashed / warn). */
  deEmphasize: boolean;
  /** The transparent sub-signals, surfaced in the "How we calculated this" card. */
  rationale: {
    compCount: number;
    /** stdev / median — lower is tighter. */
    coefficientOfVariation: number;
    /** Mean comp age in days. */
    meanAgeDays: number;
    /** True when compCount < minComps and confidence was forced to Low. */
    forcedLowByThinSample: boolean;
  };
}

/** Tunable scoring constants (kept local; adjust with fixtures, not vibes). */
const SATURATION_COMPS = 10; // count at/above which the count signal maxes out
const MAX_CV = 0.5; // CV at/above which the spread signal hits zero
const MAX_AGE_DAYS = 180; // mean age at/above which the recency signal hits zero
const WEIGHTS = { count: 0.4, spread: 0.35, recency: 0.25 } as const;
const LEVEL_HIGH = 67;
const LEVEL_MEDIUM = 34;
const THIN_SAMPLE_SCORE_CAP = 33; // keeps a forced-Low sample numerically Low too

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((s, v) => s + v, 0) / values.length;
}

/**
 * Score the confidence of a rent estimate built from `comps`.
 *
 * @param comps  Matched comparable rentals (beds/baths/size/type filtering is
 *               done upstream; this function scores whatever set it is given).
 * @param minComps  Minimum comps for a non-forced-Low result. Defaults to the
 *                  conservative project default.
 */
export function scoreRentConfidence(
  comps: readonly RentComp[],
  minComps: number = CONSERVATIVE_DEFAULTS.minCompsForConfidence,
): ConfidenceResult {
  const compCount = comps.length;
  const rents = comps.map((c) => c.rent);
  const cv = compCount > 0 ? coefficientOfVariation(rents) : 0;
  const meanAgeDays = mean(comps.map((c) => c.ageDays));

  const countSignal = clamp01(compCount / SATURATION_COMPS);
  const spreadSignal = clamp01(1 - cv / MAX_CV);
  const recencySignal = clamp01(1 - meanAgeDays / MAX_AGE_DAYS);

  let score =
    (WEIGHTS.count * countSignal +
      WEIGHTS.spread * spreadSignal +
      WEIGHTS.recency * recencySignal) *
    100;

  const forcedLowByThinSample = compCount < minComps;
  if (forcedLowByThinSample) {
    score = Math.min(score, THIN_SAMPLE_SCORE_CAP);
  }

  const level: ConfidenceLevel = forcedLowByThinSample
    ? "Low"
    : score >= LEVEL_HIGH
      ? "High"
      : score >= LEVEL_MEDIUM
        ? "Medium"
        : "Low";

  return {
    score: Math.round(score),
    level,
    deEmphasize: forcedLowByThinSample || level === "Low",
    rationale: {
      compCount,
      coefficientOfVariation: cv,
      meanAgeDays,
      forcedLowByThinSample,
    },
  };
}

/**
 * The rent basis: median of the comps' rents. Median, never mean (brief 2.5).
 * Returns null for an empty comp set so the caller can decide how to render a
 * "no data" pin rather than fabricating a number.
 */
export function medianCompRent(comps: readonly RentComp[]): number | null {
  if (comps.length === 0) return null;
  return median(comps.map((c) => c.rent));
}
