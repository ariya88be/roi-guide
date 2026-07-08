/**
 * Turn a screened listing + a rent basis into a persistence-ready ROI record,
 * under conservative DEFAULT assumptions (the map's baseline coloring). When a
 * user moves the sliders, the API recomputes cash flow on the fly with the pure
 * engine — only this default result is stored.
 *
 * Pure module.
 */

import { computeMonthlyCashFlow } from "@/lib/roi/cashflow";
import { CONSERVATIVE_DEFAULTS } from "@/lib/roi/defaults";
import { isAtypicallySmall } from "@/lib/roi/sizeSanity";
import type { FinancingInput } from "@/lib/roi/amortization";

/** Version tag for the assumption set used; lets us recompute stale rows later. */
export const ASSUMPTIONS_VERSION = "conservative-defaults-v1";

export type ConfidenceLevel = "Low" | "Medium" | "High";

/**
 * Coarse, honest confidence for a ZIP-median rent basis. Because this is NOT
 * property-level comps, it never reaches "High" — the differentiator-grade
 * per-property confidence lands in Phase 2.
 */
export function coarseZipConfidence(sampleSize: number | null): {
  score: number;
  level: ConfidenceLevel;
  deEmphasize: boolean;
} {
  const n = sampleSize ?? 0;
  if (n >= 20) return { score: 55, level: "Medium", deEmphasize: false };
  if (n >= 8) return { score: 40, level: "Medium", deEmphasize: false };
  return { score: 25, level: "Low", deEmphasize: true };
}

export interface ListingRoiInput {
  price: number;
  monthlyRent: number;
  /** null = HOA unknown (flagged, never a silent zero). */
  monthlyHoa: number | null;
  /** Sample size behind the rent basis, for coarse confidence. */
  sampleSize: number | null;
  allCash?: boolean;
  /** For the size-sanity check — the ZIP bedroom-median rent may not apply to
   * an atypically small unit (see lib/roi/sizeSanity). */
  squareFootage?: number | null;
  bedrooms?: number | null;
}

export interface ComputedRoiRecord {
  medianRent: number;
  avmRent: number | null;
  monthlyCashFlow: number;
  /**
   * Target-INDEPENDENT cash-flow sign (positive|negative|breakeven), stored for
   * stats/filtering. The map's gradient colour is target-RELATIVE and computed
   * at render time by lib/roi/color.colorForCashFlow(cashFlow, userTarget).
   */
  cashFlowSign: "positive" | "negative" | "breakeven";
  confidenceScore: number;
  confidenceLevel: ConfidenceLevel;
  deEmphasize: boolean;
  hoaMissing: boolean;
  taxEstimated: boolean;
  insuranceEstimated: boolean;
  assumptionsHash: string;
}

export function computeListingRoi(input: ListingRoiInput): ComputedRoiRecord {
  const financing: FinancingInput = {
    price: input.price,
    allCash: input.allCash ?? false,
    downPaymentPct: CONSERVATIVE_DEFAULTS.downPaymentPct,
    annualRatePct: CONSERVATIVE_DEFAULTS.annualRatePct,
    termMonths: CONSERVATIVE_DEFAULTS.termMonths,
  };

  const cf = computeMonthlyCashFlow({
    price: input.price,
    monthlyRent: input.monthlyRent,
    financing,
    monthlyHoa: input.monthlyHoa,
  });

  let conf = coarseZipConfidence(input.sampleSize);
  // A unit too small for its bedroom count breaks the "bedroom-matched ZIP
  // median" assumption entirely — force Low regardless of how many comps the
  // ZIP has, since the comps aren't for units like this one.
  if (isAtypicallySmall(input.squareFootage, input.bedrooms)) {
    conf = { score: Math.min(conf.score, 20), level: "Low", deEmphasize: true };
  }

  return {
    medianRent: input.monthlyRent,
    avmRent: null,
    monthlyCashFlow: cf.monthlyCashFlow,
    cashFlowSign: cf.cashFlowLabel,
    confidenceScore: conf.score,
    confidenceLevel: conf.level,
    deEmphasize: conf.deEmphasize,
    hoaMissing: cf.flags.hoaMissing,
    taxEstimated: cf.flags.propertyTaxEstimated,
    insuranceEstimated: cf.flags.insuranceEstimated,
    assumptionsHash: ASSUMPTIONS_VERSION,
  };
}
