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

  it("forces Low + de-emphasise for a multi-unit type (per-unit rent vs whole-building price)", () => {
    const r = computeListingRoi({
      price: 900_000,
      monthlyRent: 2600,
      monthlyHoa: 0,
      sampleSize: 30, // would be Medium
      propertyType: "Multi-Family",
    });
    expect(r.confidenceLevel).toBe("Low");
    expect(r.deEmphasize).toBe(true);
  });

  it("does not de-emphasise a normal single-family with a healthy sample", () => {
    const r = computeListingRoi({
      price: 500_000,
      monthlyRent: 2600,
      monthlyHoa: 0,
      sampleSize: 30,
      propertyType: "Single Family",
      squareFootage: 1600,
      bedrooms: 3,
      bedroomMatched: true,
      zipMedianRentPerSqft: 2.5,
    });
    expect(r.confidenceLevel).toBe("Medium");
    expect(r.deEmphasize).toBe(false);
  });

  it("forces Low + de-emphasise when the rent basis implies an absurd rent/sqft", () => {
    // 440 sqft studio handed the ZIP's $6,000 overall median ⇒ ~$13.6/sqft vs a $3.5 norm.
    const r = computeListingRoi({
      price: 370_000,
      monthlyRent: 6000,
      monthlyHoa: 0,
      sampleSize: 30,
      squareFootage: 440,
      bedrooms: 0,
      zipMedianRentPerSqft: 3.5,
    });
    expect(r.confidenceLevel).toBe("Low");
    expect(r.deEmphasize).toBe(true);
  });

  it("caps confidence at Low when the rent basis fell back off bedroom-match", () => {
    const r = computeListingRoi({
      price: 500_000,
      monthlyRent: 2600,
      monthlyHoa: 0,
      sampleSize: 30, // would be Medium if bedroom-matched
      bedroomMatched: false,
    });
    expect(r.confidenceLevel).toBe("Low");
  });
});
