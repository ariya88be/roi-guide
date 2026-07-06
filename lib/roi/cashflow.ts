/**
 * Monthly pre-tax cash-flow engine — the honest core of ROI Guide.
 *
 * Brief section 7. Every expense line the naive tools omit is mandatory here,
 * and every estimated or missing input raises a flag that the UI must surface
 * (progressive disclosure, section 8) and that lowers rent confidence.
 *
 * This module is pure: no I/O, no clock, no randomness. It is the single source
 * of truth for "what does this property actually cash-flow?" and is exercised
 * by QA section 15.A before any UI or API consumes it.
 */

import { monthlyMortgagePayment, type FinancingInput } from "./amortization";
import { CONSERVATIVE_DEFAULTS, type RoiDefaults } from "./defaults";

/** A single expense line, in monthly dollars, with provenance. */
export interface ExpenseLine {
  monthly: number;
  /** How this number was obtained — drives the "flagged if estimated" UI. */
  source: "record" | "estimated" | "assumption" | "missing-defaulted-zero";
}

export interface CashFlowInput {
  /** Purchase price in dollars. */
  price: number;
  /** Median comparable monthly rent (the rent basis). */
  monthlyRent: number;
  /** Financing terms (all-cash supported). */
  financing: FinancingInput;
  /**
   * Monthly HOA dues. `null` means unknown — we do NOT silently treat unknown
   * as $0. Instead we flag it and (per section 2.4) the caller should lower
   * confidence. `0` is a legitimate value meaning "confirmed no HOA".
   */
  monthlyHoa: number | null;
  /** Record-level monthly property tax, if known; otherwise derived from rate. */
  monthlyPropertyTax?: number | null;
  /** Record-level monthly insurance, if known; otherwise derived from rate. */
  monthlyInsurance?: number | null;
  /** Assumption overrides; anything omitted falls back to CONSERVATIVE_DEFAULTS. */
  assumptions?: Partial<RoiDefaults>;
}

export interface CashFlowResult {
  monthlyRent: number;
  /** Itemised monthly expenses (all positive numbers). */
  expenses: {
    vacancy: ExpenseLine;
    management: ExpenseLine;
    maintenance: ExpenseLine;
    mortgage: ExpenseLine;
    propertyTax: ExpenseLine;
    insurance: ExpenseLine;
    hoa: ExpenseLine;
  };
  /** Sum of all expense lines. */
  totalMonthlyExpenses: number;
  /** Rent minus total expenses. May be negative. */
  monthlyCashFlow: number;
  /** True when monthlyCashFlow < 0 — the UI must label these clearly. */
  isNegative: boolean;
  /** Human-facing sign label for accessibility / non-colour encoding. */
  cashFlowLabel: "positive" | "negative" | "breakeven";
  /** Data-quality flags that must be shown and should lower confidence. */
  flags: {
    /** HOA was unknown (null) and defaulted to $0 — treat estimate with caution. */
    hoaMissing: boolean;
    /** Property tax was estimated from a rate, not read from a record. */
    propertyTaxEstimated: boolean;
    /** Insurance was estimated from a rate, not read from a record. */
    insuranceEstimated: boolean;
  };
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Compute the full monthly pre-tax cash flow for a property.
 *
 * Conservative-by-default: any assumption not supplied uses
 * {@link CONSERVATIVE_DEFAULTS}, and any missing cost is flagged rather than
 * assumed favourable.
 */
export function computeMonthlyCashFlow(input: CashFlowInput): CashFlowResult {
  if (!Number.isFinite(input.price) || input.price <= 0) {
    throw new RangeError(`computeMonthlyCashFlow: price must be > 0, got ${input.price}`);
  }
  if (!Number.isFinite(input.monthlyRent) || input.monthlyRent < 0) {
    throw new RangeError(
      `computeMonthlyCashFlow: monthlyRent must be >= 0, got ${input.monthlyRent}`,
    );
  }

  const a: RoiDefaults = { ...CONSERVATIVE_DEFAULTS, ...input.assumptions };
  const rent = input.monthlyRent;

  const vacancy: ExpenseLine = { monthly: rent * a.vacancyPct, source: "assumption" };
  const management: ExpenseLine = { monthly: rent * a.managementPct, source: "assumption" };
  const maintenance: ExpenseLine = { monthly: rent * a.maintenancePct, source: "assumption" };
  const mortgage: ExpenseLine = {
    monthly: monthlyMortgagePayment(input.financing),
    source: "assumption",
  };

  // Property tax: prefer a record figure; otherwise estimate from price * rate.
  const taxEstimated = input.monthlyPropertyTax == null;
  const propertyTax: ExpenseLine = taxEstimated
    ? { monthly: (input.price * a.propertyTaxAnnualRate) / 12, source: "estimated" }
    : { monthly: input.monthlyPropertyTax as number, source: "record" };

  // Insurance: prefer a record figure; otherwise estimate from price * rate.
  const insEstimated = input.monthlyInsurance == null;
  const insurance: ExpenseLine = insEstimated
    ? { monthly: (input.price * a.insuranceAnnualRate) / 12, source: "estimated" }
    : { monthly: input.monthlyInsurance as number, source: "record" };

  // HOA: null means unknown. We default the NUMBER to 0 so the math resolves,
  // but we flag it loudly — never a silent optimistic zero (brief 2.4).
  const hoaMissing = input.monthlyHoa == null;
  const hoa: ExpenseLine = hoaMissing
    ? { monthly: 0, source: "missing-defaulted-zero" }
    : { monthly: input.monthlyHoa as number, source: "record" };

  const expenses = { vacancy, management, maintenance, mortgage, propertyTax, insurance, hoa };
  const totalMonthlyExpenses = Object.values(expenses).reduce((sum, e) => sum + e.monthly, 0);
  const monthlyCashFlow = rent - totalMonthlyExpenses;

  const cashFlowLabel: CashFlowResult["cashFlowLabel"] =
    round2(monthlyCashFlow) > 0 ? "positive" : round2(monthlyCashFlow) < 0 ? "negative" : "breakeven";

  return {
    monthlyRent: rent,
    expenses,
    totalMonthlyExpenses,
    monthlyCashFlow,
    isNegative: round2(monthlyCashFlow) < 0,
    cashFlowLabel,
    flags: {
      hoaMissing,
      propertyTaxEstimated: taxEstimated,
      insuranceEstimated: insEstimated,
    },
  };
}
