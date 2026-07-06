/**
 * Fixed-rate mortgage amortization.
 *
 * Standard formula (brief section 7):
 *   M = P * [ r(1+r)^n ] / [ (1+r)^n - 1 ]
 *   P = loan principal, r = monthly rate = APR/12, n = term in months.
 *
 * Pure functions, no rounding applied internally — callers round at the
 * presentation layer so intermediate sums stay exact.
 */

/**
 * Monthly principal + interest payment for a loan principal.
 *
 * Edge cases handled explicitly (these are QA fixtures, section 15.A):
 *  - principal <= 0  -> 0        (all-cash purchase: no mortgage payment)
 *  - annualRatePct 0 -> P / n    (interest-free: straight-line principal)
 *
 * @param principal   Loan amount in dollars (price minus down payment).
 * @param annualRatePct Annual percentage rate, e.g. 7 for 7%.
 * @param termMonths  Amortization term in months, e.g. 360 for 30 years.
 */
export function amortizedMonthlyPayment(
  principal: number,
  annualRatePct: number,
  termMonths: number,
): number {
  if (!Number.isFinite(principal) || !Number.isFinite(annualRatePct) || !Number.isFinite(termMonths)) {
    throw new TypeError("amortizedMonthlyPayment: all arguments must be finite numbers");
  }
  if (termMonths <= 0) {
    throw new RangeError(`amortizedMonthlyPayment: termMonths must be > 0, got ${termMonths}`);
  }
  if (annualRatePct < 0) {
    throw new RangeError(`amortizedMonthlyPayment: annualRatePct must be >= 0, got ${annualRatePct}`);
  }
  if (principal <= 0) return 0;

  const r = annualRatePct / 100 / 12;
  if (r === 0) return principal / termMonths;

  const growth = Math.pow(1 + r, termMonths);
  return (principal * (r * growth)) / (growth - 1);
}

/** Inputs describing how a purchase is financed. */
export interface FinancingInput {
  /** Purchase price in dollars. */
  price: number;
  /** If true, no loan is taken and P&I is 0 regardless of the other fields. */
  allCash: boolean;
  /** Down payment as a fraction, e.g. 0.20 for 20%. Ignored when allCash. */
  downPaymentPct: number;
  /** Annual percentage rate, e.g. 7 for 7%. Ignored when allCash. */
  annualRatePct: number;
  /** Term in months, e.g. 360. Ignored when allCash. */
  termMonths: number;
}

/** Loan principal implied by a financing input (0 for all-cash). */
export function loanPrincipal(input: FinancingInput): number {
  if (input.allCash) return 0;
  if (input.downPaymentPct < 0 || input.downPaymentPct > 1) {
    throw new RangeError(
      `loanPrincipal: downPaymentPct must be in [0,1], got ${input.downPaymentPct}`,
    );
  }
  return input.price * (1 - input.downPaymentPct);
}

/** Monthly P&I for a full financing input (0 for all-cash). */
export function monthlyMortgagePayment(input: FinancingInput): number {
  if (input.allCash) return 0;
  return amortizedMonthlyPayment(loanPrincipal(input), input.annualRatePct, input.termMonths);
}
