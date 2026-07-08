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
import { isAtypicallySmall, isImplausibleRentForSize } from "@/lib/roi/sizeSanity";
import { normalizeToken } from "@/lib/hygiene";
import type { FinancingInput } from "@/lib/roi/amortization";

/**
 * Property-type tokens whose sale price is for a WHOLE building of 2+ doors but
 * whose Phase-1 rent basis is a single ZIP per-unit median — so the cash flow
 * is systematically wrong (rent of one door vs mortgage/tax on the whole
 * building). We can't price these correctly until a per-door rent basis exists,
 * so they are always Low confidence + de-emphasised (the ranking then keeps
 * them out of the turnkey top; see lib/pins/query.ts qualityFactor).
 */
const MULTI_UNIT_TYPE_TOKENS = new Set([
  "multifamily",
  "duplex",
  "triplex",
  "fourplex",
  "quadruplex",
]);

function isMultiUnitType(propertyType: string | null | undefined): boolean {
  if (!propertyType) return false;
  return MULTI_UNIT_TYPE_TOKENS.has(normalizeToken(propertyType));
}

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
  /** Property type — multi-unit types can't be priced with a per-unit rent
   * basis, so they're forced Low + de-emphasised (see isMultiUnitType). */
  propertyType?: string | null;
  /** True when the rent basis was matched to the listing's bedroom count;
   * false = it fell back to the coarser ZIP-overall median (lower confidence). */
  bedroomMatched?: boolean;
  /** ZIP median rent per sqft — used to catch an implausible rent/sqft basis. */
  zipMedianRentPerSqft?: number | null;
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

  // The rent basis fell back from bedroom-matched to the coarse ZIP-overall
  // median (e.g. bedrooms unknown, or the ZIP has no per-bedroom breakdown) —
  // a materially weaker basis, so it can't stay "Medium".
  if (input.bedroomMatched === false) {
    conf = { score: Math.min(conf.score, 35), level: "Low", deEmphasize: conf.deEmphasize };
  }

  // Each of these means "the ZIP per-unit median clearly does not fit this
  // listing", so the resulting cash flow is not to be trusted — force Low +
  // de-emphasise (the map ranking then keeps it out of the turnkey top):
  //  - a unit too small for its bedroom count (micro-unit);
  //  - a rent/sqft implausibly high vs the ZIP norm (big-unit median on a tiny unit);
  //  - a multi-unit building priced whole but rented as one door.
  const basisClearlyWrong =
    isAtypicallySmall(input.squareFootage, input.bedrooms) ||
    isImplausibleRentForSize(input.monthlyRent, input.squareFootage, input.zipMedianRentPerSqft) ||
    isMultiUnitType(input.propertyType);
  if (basisClearlyWrong) {
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
