import { describe, it, expect } from "vitest";
import { computeMonthlyCashFlow, type CashFlowInput } from "./cashflow";

const ALL_CASH = {
  price: 500_000,
  allCash: true as const,
  downPaymentPct: 0.2,
  annualRatePct: 7,
  termMonths: 360,
};
const FINANCED = { ...ALL_CASH, allCash: false as const };

/**
 * Hand-verified fixture (Koreatown-style 2/2 condo), all-cash so the mortgage
 * line is 0 and every number is checkable by hand:
 *   rent 2600
 *   vacancy    6% -> 156
 *   management 8% -> 208
 *   maintenance 8% -> 208
 *   property tax 1.25%/yr of 500k -> 520.833/mo (estimated)
 *   insurance  0.35%/yr of 500k -> 145.833/mo (estimated)
 *   HOA 450 (known)
 *   total expenses 1688.667  ->  CF = 2600 - 1688.667 = 911.333
 */
describe("computeMonthlyCashFlow — hand-verified fixture (all-cash)", () => {
  const base: CashFlowInput = { price: 500_000, monthlyRent: 2600, financing: ALL_CASH, monthlyHoa: 450 };

  it("matches the hand-computed cash flow", () => {
    const r = computeMonthlyCashFlow(base);
    expect(r.expenses.vacancy.monthly).toBeCloseTo(156, 6);
    expect(r.expenses.management.monthly).toBeCloseTo(208, 6);
    expect(r.expenses.maintenance.monthly).toBeCloseTo(208, 6);
    expect(r.expenses.mortgage.monthly).toBe(0); // all-cash
    expect(r.expenses.propertyTax.monthly).toBeCloseTo(520.8333, 3);
    expect(r.expenses.insurance.monthly).toBeCloseTo(145.8333, 3);
    expect(r.expenses.hoa.monthly).toBe(450);
    expect(r.totalMonthlyExpenses).toBeCloseTo(1688.6667, 3);
    expect(r.monthlyCashFlow).toBeCloseTo(911.3333, 3);
    expect(r.isNegative).toBe(false);
    expect(r.cashFlowLabel).toBe("positive");
  });

  it("applies conservative defaults when assumptions are omitted", () => {
    const r = computeMonthlyCashFlow(base);
    // vacancy/management/maintenance defaults are 6/8/8 % => sourced as assumption
    expect(r.expenses.vacancy.source).toBe("assumption");
    expect(r.expenses.management.source).toBe("assumption");
  });
});

describe("financing pulls the deal negative (realistic LA)", () => {
  it("20% down @7%/30yr flips the same property to a labelled loss", () => {
    const r = computeMonthlyCashFlow({ price: 500_000, monthlyRent: 2600, financing: FINANCED, monthlyHoa: 450 });
    expect(r.expenses.mortgage.monthly).toBeCloseTo(2661.21, 1);
    expect(r.monthlyCashFlow).toBeCloseTo(-1749.88, 1);
    expect(r.isNegative).toBe(true);
    expect(r.cashFlowLabel).toBe("negative");
  });
});

describe("missing HOA is flagged, never a silent zero (brief 2.4)", () => {
  it("null HOA -> flagged, defaulted to 0 with an explicit source", () => {
    const r = computeMonthlyCashFlow({ price: 500_000, monthlyRent: 2600, financing: ALL_CASH, monthlyHoa: null });
    expect(r.flags.hoaMissing).toBe(true);
    expect(r.expenses.hoa.monthly).toBe(0);
    expect(r.expenses.hoa.source).toBe("missing-defaulted-zero");
  });

  it("a confirmed $0 HOA is NOT flagged as missing", () => {
    const r = computeMonthlyCashFlow({ price: 500_000, monthlyRent: 2600, financing: ALL_CASH, monthlyHoa: 0 });
    expect(r.flags.hoaMissing).toBe(false);
    expect(r.expenses.hoa.source).toBe("record");
  });
});

describe("record vs estimated cost provenance", () => {
  it("uses record tax/insurance when provided and clears the estimated flags", () => {
    const r = computeMonthlyCashFlow({
      price: 500_000,
      monthlyRent: 2600,
      financing: ALL_CASH,
      monthlyHoa: 450,
      monthlyPropertyTax: 600,
      monthlyInsurance: 120,
    });
    expect(r.expenses.propertyTax.monthly).toBe(600);
    expect(r.expenses.propertyTax.source).toBe("record");
    expect(r.expenses.insurance.monthly).toBe(120);
    expect(r.flags.propertyTaxEstimated).toBe(false);
    expect(r.flags.insuranceEstimated).toBe(false);
  });

  it("flags tax/insurance as estimated when omitted", () => {
    const r = computeMonthlyCashFlow({ price: 500_000, monthlyRent: 2600, financing: ALL_CASH, monthlyHoa: 450 });
    expect(r.flags.propertyTaxEstimated).toBe(true);
    expect(r.flags.insuranceEstimated).toBe(true);
    expect(r.expenses.propertyTax.source).toBe("estimated");
  });
});

describe("input guards", () => {
  it("rejects non-positive price", () => {
    expect(() => computeMonthlyCashFlow({ price: 0, monthlyRent: 2600, financing: ALL_CASH, monthlyHoa: 0 })).toThrow(
      RangeError,
    );
  });
});
