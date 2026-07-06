import { describe, it, expect } from "vitest";
import { roughAfterTaxMonthlyCashFlow, AFTER_TAX_DISCLAIMER } from "./afterTax";

describe("roughAfterTaxMonthlyCashFlow (rough, labelled estimate)", () => {
  it("computes depreciation shield with default building fraction & rate", () => {
    // building = 500k * 0.8 = 400k; /27.5 = 14,545.45/yr depreciation
    // shield = 14,545.45 * 0.24 = 3,490.91/yr = 290.91/mo
    const r = roughAfterTaxMonthlyCashFlow({ price: 500_000, preTaxMonthlyCashFlow: 0 });
    expect(r.annualDepreciation).toBeCloseTo(14_545.45, 2);
    expect(r.annualTaxShield).toBeCloseTo(3_490.91, 2);
    expect(r.roughAfterTaxMonthlyCashFlow).toBeCloseTo(290.91, 2);
  });

  it("adds the monthly shield on top of pre-tax cash flow", () => {
    const r = roughAfterTaxMonthlyCashFlow({ price: 500_000, preTaxMonthlyCashFlow: -1749.88 });
    expect(r.roughAfterTaxMonthlyCashFlow).toBeCloseTo(-1749.88 + 290.91, 2);
  });

  it("always carries the disclaimer", () => {
    const r = roughAfterTaxMonthlyCashFlow({ price: 500_000, preTaxMonthlyCashFlow: 0 });
    expect(r.disclaimer).toBe(AFTER_TAX_DISCLAIMER);
    expect(r.disclaimer).toMatch(/not tax advice/i);
  });

  it("rejects out-of-range fractions", () => {
    expect(() =>
      roughAfterTaxMonthlyCashFlow({ price: 500_000, preTaxMonthlyCashFlow: 0, buildingFraction: 1.2 }),
    ).toThrow(RangeError);
  });
});
