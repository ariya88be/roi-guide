/**
 * ROUGH after-tax estimate — deliberately crude, deliberately labelled.
 *
 * The product owner asked for pre-tax cash flow as the real number, plus a
 * single easy-math after-tax figure. This is NOT a tax engine. It models one
 * effect only: the depreciation tax shield.
 *
 *   annual depreciation ≈ (price × buildingFraction) / 27.5   (residential SL)
 *   annual tax shield   ≈ annual depreciation × marginalRate
 *   rough after-tax CF  ≈ pre-tax CF + (annual tax shield / 12)
 *
 * It intentionally IGNORES: mortgage-interest deductibility, the fact that only
 * the interest portion of P&I is deductible, passive-activity loss limits,
 * bracket phase-outs, state tax, and depreciation recapture on sale. Every
 * result carries a disclaimer string the UI must display verbatim.
 *
 * Pure module.
 */

import { CONSERVATIVE_DEFAULTS } from "./defaults";

export const AFTER_TAX_DISCLAIMER =
  "Rough estimate — not tax advice. Models only the depreciation shield; " +
  "ignores interest deductibility, passive-loss limits, bracket effects, " +
  "state tax, and depreciation recapture. Consult a tax professional.";

export interface AfterTaxInput {
  /** Purchase price in dollars. */
  price: number;
  /** Pre-tax monthly cash flow from the cash-flow engine. */
  preTaxMonthlyCashFlow: number;
  /** Fraction of price that is depreciable building (default 0.80). */
  buildingFraction?: number;
  /** Marginal tax rate as a fraction (default 0.24). */
  marginalTaxRate?: number;
}

export interface AfterTaxResult {
  annualDepreciation: number;
  annualTaxShield: number;
  roughAfterTaxMonthlyCashFlow: number;
  disclaimer: string;
}

const RESIDENTIAL_DEPRECIATION_YEARS = 27.5;

/**
 * Compute the rough after-tax monthly cash flow. See module doc for scope.
 */
export function roughAfterTaxMonthlyCashFlow(input: AfterTaxInput): AfterTaxResult {
  if (!Number.isFinite(input.price) || input.price <= 0) {
    throw new RangeError(`roughAfterTaxMonthlyCashFlow: price must be > 0, got ${input.price}`);
  }
  const buildingFraction = input.buildingFraction ?? CONSERVATIVE_DEFAULTS.buildingFraction;
  const marginalTaxRate = input.marginalTaxRate ?? CONSERVATIVE_DEFAULTS.marginalTaxRate;

  if (buildingFraction < 0 || buildingFraction > 1) {
    throw new RangeError(`buildingFraction must be in [0,1], got ${buildingFraction}`);
  }
  if (marginalTaxRate < 0 || marginalTaxRate > 1) {
    throw new RangeError(`marginalTaxRate must be in [0,1], got ${marginalTaxRate}`);
  }

  const annualDepreciation = (input.price * buildingFraction) / RESIDENTIAL_DEPRECIATION_YEARS;
  const annualTaxShield = annualDepreciation * marginalTaxRate;
  const roughAfterTaxMonthlyCashFlow = input.preTaxMonthlyCashFlow + annualTaxShield / 12;

  return {
    annualDepreciation,
    annualTaxShield,
    roughAfterTaxMonthlyCashFlow,
    disclaimer: AFTER_TAX_DISCLAIMER,
  };
}
