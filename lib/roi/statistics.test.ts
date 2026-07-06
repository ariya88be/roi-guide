import { describe, it, expect } from "vitest";
import {
  mean,
  median,
  percentile,
  interquartileRange,
  sampleStdDev,
  coefficientOfVariation,
  robustSpreadRatio,
  EmptyDatasetError,
} from "./statistics";

describe("median (the rent basis — must resist outliers)", () => {
  it("returns the middle value for odd-length sets", () => {
    expect(median([1000, 2000, 3000])).toBe(2000);
  });

  it("the brief's canonical case: [1000,1000,1000,4000] -> 1000, NOT the mean 1750", () => {
    expect(median([1000, 1000, 1000, 4000])).toBe(1000);
    expect(mean([1000, 1000, 1000, 4000])).toBe(1750);
  });

  it("averages the two central values for even-length sets", () => {
    expect(median([1000, 2000, 3000, 5000])).toBe(2500);
  });

  it("is order-independent", () => {
    expect(median([4000, 1000, 1000, 1000])).toBe(1000);
  });

  it("throws on an empty set rather than inventing a number", () => {
    expect(() => median([])).toThrow(EmptyDatasetError);
  });
});

describe("percentile / IQR", () => {
  it("computes quartiles with linear interpolation", () => {
    // 1..5 -> P25 = 2, P75 = 4, IQR = 2
    expect(percentile([1, 2, 3, 4, 5], 0.25)).toBeCloseTo(2, 10);
    expect(percentile([1, 2, 3, 4, 5], 0.75)).toBeCloseTo(4, 10);
    expect(interquartileRange([1, 2, 3, 4, 5])).toBeCloseTo(2, 10);
  });

  it("rejects out-of-range percentiles", () => {
    expect(() => percentile([1, 2, 3], 1.5)).toThrow(RangeError);
  });
});

describe("spread measures", () => {
  it("sample stdev is 0 for a single value and for identical values", () => {
    expect(sampleStdDev([2000])).toBe(0);
    expect(sampleStdDev([2000, 2000, 2000])).toBe(0);
  });

  it("coefficient of variation is 0 for a perfectly tight set", () => {
    expect(coefficientOfVariation([2000, 2000, 2000])).toBe(0);
  });

  it("coefficient of variation grows as the set widens", () => {
    const tight = coefficientOfVariation([1900, 2000, 2100]);
    const wide = coefficientOfVariation([1000, 2000, 4000]);
    expect(wide).toBeGreaterThan(tight);
  });

  it("robust spread ratio (IQR/median) is outlier-resistant", () => {
    // Adding one extreme outlier barely moves IQR/median vs. it exploding the CV.
    const base = robustSpreadRatio([1900, 2000, 2000, 2100]);
    const withOutlier = robustSpreadRatio([1900, 2000, 2000, 2100, 20000]);
    expect(withOutlier - base).toBeLessThan(0.5);
  });
});
