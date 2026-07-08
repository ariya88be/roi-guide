import { describe, it, expect } from "vitest";
import { scoreDeals, DEFAULT_DEAL_CONFIG, type DealInput } from "./deal";

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

describe("scoreDeals — relAdvantage sign with a non-positive local baseline (regression)", () => {
  // Expensive, low-rent neighborhood: everyone's cap rate is NEGATIVE (property
  // tax/insurance on price outrun modest rent even before a mortgage). This is
  // realistic, not a corner case, once prices climb into the $1M+ range.
  const negNeighbors: DealInput[] = [
    { id: "n0", lat: 34.0, lng: -118.4, price: 1_000_000, capRate: -0.02 },
    { id: "n1", lat: 34.001, lng: -118.4, price: 1_000_000, capRate: -0.02 },
    { id: "n2", lat: 34.002, lng: -118.4, price: 1_000_000, capRate: -0.02 },
  ];

  it("a property that beats a NEGATIVE local median gets a POSITIVE relAdvantage (not silently 0)", () => {
    const items = [...negNeighbors, { id: "better", lat: 34.0015, lng: -118.4, price: 1_000_000, capRate: 0.01 }];
    const r = scoreDeals(items);
    expect(r.get("better")!.localMedianCapRate).toBeLessThan(0);
    expect(r.get("better")!.relAdvantage).toBeGreaterThan(0); // was silently 0 before the fix
  });

  it("a property WORSE than a negative local median gets a NEGATIVE relAdvantage (sign not flipped)", () => {
    const items = [...negNeighbors, { id: "worse", lat: 34.0015, lng: -118.4, price: 1_000_000, capRate: -0.05 }];
    const r = scoreDeals(items);
    expect(r.get("worse")!.relAdvantage).toBeLessThan(0);
  });

  it("an exactly-zero local median no longer divides by zero (finite, sane result)", () => {
    const items = [
      { id: "z0", lat: 34.0, lng: -118.4, price: 500_000, capRate: 0 },
      { id: "z1", lat: 34.001, lng: -118.4, price: 500_000, capRate: 0 },
      { id: "target", lat: 34.0005, lng: -118.4, price: 500_000, capRate: 0.02 },
    ];
    const r = scoreDeals(items);
    expect(Number.isFinite(r.get("target")!.relAdvantage)).toBe(true);
    expect(r.get("target")!.relAdvantage).toBeGreaterThan(0);
  });
});

describe("scoreDeals — same-building cluster (the Beverly Glen micro-unit regression)", () => {
  // Three units in the SAME building, prices varying 15-30% (a real observed
  // case: 207-266 sqft "condos" at $50k/$65k/$75k), which the price+capRate
  // tolerance (10%) alone does NOT catch, since the prices differ by far more
  // than 10% from each other even though it's clearly one building/phenomenon.
  const sameLatLng = { lat: 34.063206, lng: -118.426987 };
  const items: DealInput[] = [
    { id: "u1", ...sameLatLng, price: 50_000, capRate: cap(2413, 50_000) },
    { id: "u2", ...sameLatLng, price: 65_000, capRate: cap(2393, 65_000) },
    { id: "u3", ...sameLatLng, price: 75_000, capRate: cap(2379, 75_000) },
  ];
  const r = scoreDeals(items);

  it("flags all same-building units as a cluster even though price/cap vary >10% pairwise", () => {
    // Sanity: confirm the price spread genuinely exceeds the old tolerance.
    expect(Math.abs(65_000 - 50_000) / 50_000).toBeGreaterThan(DEFAULT_DEAL_CONFIG.clusterTolerance);
    for (const id of ["u1", "u2", "u3"]) expect(r.get(id)!.cluster).toBe(true);
  });

  it("the cluster penalty dampens what would otherwise be a misleadingly high score", () => {
    const spread = items.map((it, i) => ({ ...it, lat: it.lat + i * 0.5 })); // far apart -> no cluster
    const r2 = scoreDeals(spread);
    expect(r2.get("u1")!.cluster).toBe(false);
    expect(r.get("u1")!.dealScore).toBeLessThan(r2.get("u1")!.dealScore);
  });
});
