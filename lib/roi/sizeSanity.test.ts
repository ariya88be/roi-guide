import { describe, it, expect } from "vitest";
import { isAtypicallySmall, minPlausibleSquareFootage } from "./sizeSanity";

describe("isAtypicallySmall — the Beverly Glen regression (207-266 sqft '1BR' condos)", () => {
  it("flags a 207 sqft 1-bedroom (the observed real case) as atypically small", () => {
    expect(isAtypicallySmall(207, 1)).toBe(true);
    expect(isAtypicallySmall(266, 1)).toBe(true);
  });

  it("does not flag a normal-sized 1-bedroom", () => {
    expect(isAtypicallySmall(750, 1)).toBe(false);
  });

  it("scales the floor up with bedroom count", () => {
    expect(isAtypicallySmall(500, 2)).toBe(true); // too small for a 2BR
    expect(isAtypicallySmall(500, 1)).toBe(false); // fine for a 1BR
  });

  it("never flags when square footage is unknown — no guessing from absence", () => {
    expect(isAtypicallySmall(null, 1)).toBe(false);
    expect(isAtypicallySmall(undefined, 1)).toBe(false);
    expect(isAtypicallySmall(0, 1)).toBe(false);
  });

  it("treats missing bedroom count as a 1BR floor", () => {
    expect(isAtypicallySmall(200, null)).toBe(true);
    expect(isAtypicallySmall(500, null)).toBe(false);
  });
});

describe("minPlausibleSquareFootage", () => {
  it("increases with bedroom count", () => {
    const s0 = minPlausibleSquareFootage(0);
    const s1 = minPlausibleSquareFootage(1);
    const s2 = minPlausibleSquareFootage(2);
    const s4 = minPlausibleSquareFootage(4);
    expect(s1).toBeGreaterThan(s0);
    expect(s2).toBeGreaterThan(s1);
    expect(s4).toBeGreaterThan(s2);
  });
});
