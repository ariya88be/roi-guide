import { describe, it, expect } from "vitest";
import {
  amortizedMonthlyPayment,
  monthlyMortgagePayment,
  loanPrincipal,
} from "./amortization";

describe("amortizedMonthlyPayment (QA 15.A known-loan fixture)", () => {
  it("P=$320,000, 7% APR, 360 months ≈ $2,128.97", () => {
    const m = amortizedMonthlyPayment(320_000, 7, 360);
    expect(m).toBeCloseTo(2128.97, 2);
  });

  it("0% APR amortises straight-line: P / n", () => {
    expect(amortizedMonthlyPayment(360_000, 0, 360)).toBeCloseTo(1000, 10);
  });

  it("zero or negative principal (all-cash) yields 0", () => {
    expect(amortizedMonthlyPayment(0, 7, 360)).toBe(0);
    expect(amortizedMonthlyPayment(-5, 7, 360)).toBe(0);
  });

  it("rejects invalid term / negative rate", () => {
    expect(() => amortizedMonthlyPayment(100_000, 7, 0)).toThrow(RangeError);
    expect(() => amortizedMonthlyPayment(100_000, -1, 360)).toThrow(RangeError);
  });
});

describe("financing wrappers", () => {
  it("loanPrincipal applies the down payment", () => {
    expect(
      loanPrincipal({ price: 500_000, allCash: false, downPaymentPct: 0.2, annualRatePct: 7, termMonths: 360 }),
    ).toBe(400_000);
  });

  it("all-cash means no loan and no payment", () => {
    const fin = { price: 500_000, allCash: true, downPaymentPct: 0.2, annualRatePct: 7, termMonths: 360 };
    expect(loanPrincipal(fin)).toBe(0);
    expect(monthlyMortgagePayment(fin)).toBe(0);
  });

  it("$400k loan at 7%/360 matches the primitive", () => {
    const fin = { price: 500_000, allCash: false, downPaymentPct: 0.2, annualRatePct: 7, termMonths: 360 };
    expect(monthlyMortgagePayment(fin)).toBeCloseTo(amortizedMonthlyPayment(400_000, 7, 360), 10);
  });
});
