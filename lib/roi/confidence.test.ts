import { describe, it, expect } from "vitest";
import { scoreRentConfidence, medianCompRent, type RentComp } from "./confidence";

/** Build N comps at a given rent and age. */
function comps(n: number, rent: number, ageDays = 10): RentComp[] {
  return Array.from({ length: n }, () => ({ rent, ageDays }));
}

describe("scoreRentConfidence (QA 15.B)", () => {
  it("rises with comp count (more comps -> higher confidence)", () => {
    const few = scoreRentConfidence(comps(4, 2000));
    const many = scoreRentConfidence(comps(10, 2000));
    expect(many.score).toBeGreaterThan(few.score);
  });

  it("falls as spread widens (tighter comps -> higher confidence)", () => {
    const tight = scoreRentConfidence([
      { rent: 1950, ageDays: 10 },
      { rent: 2000, ageDays: 10 },
      { rent: 2050, ageDays: 10 },
      { rent: 2000, ageDays: 10 },
    ]);
    const wide = scoreRentConfidence([
      { rent: 1000, ageDays: 10 },
      { rent: 2000, ageDays: 10 },
      { rent: 3500, ageDays: 10 },
      { rent: 2000, ageDays: 10 },
    ]);
    expect(tight.score).toBeGreaterThan(wide.score);
  });

  it("falls as comps get stale (newer -> higher confidence)", () => {
    const fresh = scoreRentConfidence(comps(6, 2000, 5));
    const stale = scoreRentConfidence(comps(6, 2000, 150));
    expect(fresh.score).toBeGreaterThan(stale.score);
  });

  it("fewer than the minimum comps forces Low and sets de-emphasis", () => {
    const thin = scoreRentConfidence(comps(2, 2000, 1)); // default min = 3
    expect(thin.level).toBe("Low");
    expect(thin.deEmphasize).toBe(true);
    expect(thin.rationale.forcedLowByThinSample).toBe(true);
    // even a perfect tight/fresh set cannot rise above the thin-sample cap
    expect(thin.score).toBeLessThanOrEqual(33);
  });

  it("a healthy set (many, tight, fresh) reaches High and is not de-emphasised", () => {
    const good = scoreRentConfidence(comps(10, 2000, 5));
    expect(good.level).toBe("High");
    expect(good.deEmphasize).toBe(false);
  });
});

describe("medianCompRent", () => {
  it("uses the median (outlier-proof)", () => {
    expect(
      medianCompRent([
        { rent: 1000, ageDays: 1 },
        { rent: 1000, ageDays: 1 },
        { rent: 1000, ageDays: 1 },
        { rent: 4000, ageDays: 1 },
      ]),
    ).toBe(1000);
  });

  it("returns null for an empty set instead of fabricating a number", () => {
    expect(medianCompRent([])).toBeNull();
  });
});
