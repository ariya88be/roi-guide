import { describe, it, expect } from "vitest";
import { computeListingRoi, coarseZipConfidence, ASSUMPTIONS_VERSION } from "./compute";

describe("coarseZipConfidence (ZIP-median basis never reaches High)", () => {
  it("is Low + de-emphasised for a thin/absent sample", () => {
    expect(coarseZipConfidence(null)).toEqual({ score: 25, level: "Low", deEmphasize: true });
    expect(coarseZipConfidence(5).level).toBe("Low");
  });
  it("is Medium for a healthier sample, never High", () => {
    expect(coarseZipConfidence(8).level).toBe("Medium");
    expect(coarseZipConfidence(50).level).toBe("Medium");
  });
});

describe("computeListingRoi", () => {
  it("financed default assumptions produce a labelled negative cash flow", () => {
    const r = computeListingRoi({ price: 500_000, monthlyRent: 2600, monthlyHoa: 450, sampleSize: 30 });
    expect(r.monthlyCashFlow).toBeCloseTo(-1749.88, 1);
    expect(r.cashFlowSign).toBe("negative");
    expect(r.confidenceLevel).toBe("Medium");
    expect(r.hoaMissing).toBe(false);
    expect(r.taxEstimated).toBe(true);
    expect(r.insuranceEstimated).toBe(true);
    expect(r.assumptionsHash).toBe(ASSUMPTIONS_VERSION);
  });

  it("flags a missing HOA and lowers confidence for a thin sample", () => {
    const r = computeListingRoi({ price: 500_000, monthlyRent: 2600, monthlyHoa: null, sampleSize: 2 });
    expect(r.hoaMissing).toBe(true);
    expect(r.deEmphasize).toBe(true);
    expect(r.confidenceLevel).toBe("Low");
  });

  it("all-cash flips the same property positive", () => {
    const r = computeListingRoi({ price: 500_000, monthlyRent: 2600, monthlyHoa: 450, sampleSize: 30, allCash: true });
    expect(r.monthlyCashFlow).toBeCloseTo(911.33, 1);
    expect(r.cashFlowSign).toBe("positive");
  });
});
