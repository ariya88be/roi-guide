import { describe, it, expect } from "vitest";
import { scoreDeals, type DealInput } from "./deal";

/** All-cash cap rate for a home netting `monthly` at `price`. */
const cap = (monthly: number, price: number) => (monthly * 12) / price;

describe("scoreDeals — the $400k-vs-$700k example (capital efficiency + local outlier)", () => {
  // 8 homes at $700k netting $1,400 (≈2.4% cap) clustered around a point,
  // plus ONE $400k home netting the same $1,400 (≈4.2% cap) in their midst.
  const items: DealInput[] = [];
  for (let i = 0; i < 8; i++) {
    items.push({
      id: `exp${i}`,
      lat: 34.0 + (i % 4) * 0.01,
      lng: -117.5 + Math.floor(i / 4) * 0.01,
      price: 700_000,
      capRate: cap(1400, 700_000),
    });
  }
  items.push({ id: "bargain", lat: 34.005, lng: -117.505, price: 400_000, capRate: cap(1400, 400_000) });
  const r = scoreDeals(items);

  it("the cheaper home (same return, less capital) scores far greener", () => {
    expect(r.get("bargain")!.dealScore).toBeGreaterThan(r.get("exp0")!.dealScore);
    expect(r.get("bargain")!.dealScore).toBeGreaterThan(0.75);
  });

  it("the bargain reads as a local OUTLIER; the pricey peers read as market-rate", () => {
    expect(r.get("bargain")!.relAdvantage).toBeGreaterThan(0.5); // beats its neighborhood
    expect(Math.abs(r.get("exp0")!.relAdvantage)).toBeLessThan(0.15); // ~neighborhood norm
  });

  it("the bargain is flagged below-market for verification (not hidden)", () => {
    expect(r.get("bargain")!.belowMarket).toBe(true);
  });
});

describe("scoreDeals — the '10 identical cheap units' example (High-High cluster = sketchy)", () => {
  // 6 near-identical $400k / $1,400 homes packed together.
  const items: DealInput[] = [];
  for (let i = 0; i < 6; i++) {
    items.push({ id: `c${i}`, lat: 34.0 + i * 0.001, lng: -117.5, price: 400_000, capRate: cap(1400, 400_000) });
  }
  const r = scoreDeals(items);

  it("flags every unit as a homogeneous cluster", () => {
    for (let i = 0; i < 6; i++) expect(r.get(`c${i}`)!.cluster).toBe(true);
  });

  it("they are NOT local standouts (relative advantage ≈ 0)", () => {
    for (let i = 0; i < 6; i++) expect(Math.abs(r.get(`c${i}`)!.relAdvantage)).toBeLessThan(0.01);
  });

  it("the cluster penalty dampens their score (not bright green just for being cheap)", () => {
    // Same units WITHOUT the cluster (spread far apart) would score higher.
    const spread = items.map((it, i) => ({ ...it, lat: 34.0 + i * 0.1 }));
    const r2 = scoreDeals(spread);
    expect(r2.get("c0")!.cluster).toBe(false);
    expect(r.get("c0")!.dealScore).toBeLessThan(r2.get("c0")!.dealScore);
  });
});

describe("scoreDeals — degenerate inputs", () => {
  it("a lone listing gets a neutral score and no flags", () => {
    const r = scoreDeals([{ id: "solo", lat: 34, lng: -117.5, price: 400_000, capRate: 0.04 }]);
    expect(r.get("solo")!.cluster).toBe(false);
    expect(r.get("solo")!.relAdvantage).toBe(0);
    expect(r.get("solo")!.neighborCount).toBe(0);
  });
});
