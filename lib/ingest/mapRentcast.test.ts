import { describe, it, expect } from "vitest";
import { toScreenableListing, pickBedroomMedianRent, extractPriceHistory } from "./mapRentcast";
import type { SaleListing, RentalMarket } from "@/lib/providers/rentcast";

function listing(over: Partial<SaleListing> = {}): SaleListing {
  return {
    id: "p1",
    latitude: 34.06,
    longitude: -118.3,
    status: "Active",
    price: 500_000,
    propertyType: "Single Family",
    bedrooms: 2,
    listingType: "Standard",
    ...over,
  } as SaleListing;
}

const market: RentalMarket = {
  zipCode: "90020",
  rentalData: {
    averageRent: 2200,
    medianRent: 1850,
    minRent: 800,
    maxRent: 9000,
    totalListings: 120,
    dataByBedrooms: [
      { bedrooms: 1, medianRent: 1600, totalListings: 40 },
      { bedrooms: 2, medianRent: 2000, totalListings: 30 },
    ],
  },
};

describe("pickBedroomMedianRent", () => {
  it("uses the bedroom-matched segment median when available", () => {
    const r = pickBedroomMedianRent(market, 2);
    expect(r).toEqual({ rent: 2000, sampleSize: 30, bedroomMatched: true });
  });

  it("falls back to the ZIP overall median for an unlisted bedroom count", () => {
    const r = pickBedroomMedianRent(market, 4);
    expect(r).toEqual({ rent: 1850, sampleSize: 120, bedroomMatched: false });
  });

  it("falls back to overall when bedrooms is unknown", () => {
    expect(pickBedroomMedianRent(market, null).rent).toBe(1850);
  });

  it("rounds fractional bedrooms to match a segment", () => {
    // 2.0 baths shouldn't matter; 2 beds matches the 2-bed segment
    expect(pickBedroomMedianRent(market, 2).rent).toBe(2000);
  });

  it("falls back to overall when there is no per-bedroom breakdown", () => {
    const noBreakdown: RentalMarket = { zipCode: "90020", rentalData: { averageRent: 2200, medianRent: 1850 } };
    expect(pickBedroomMedianRent(noBreakdown, 2)).toEqual({ rent: 1850, sampleSize: null, bedroomMatched: false });
  });
});

describe("toScreenableListing", () => {
  it("derives isActive from status and stamps lastSeen = now", () => {
    const now = new Date("2026-07-07T00:00:00Z");
    const s = toScreenableListing(listing({ status: "Active" }), now);
    expect(s.isActive).toBe(true);
    expect(s.lastSeen).toBe(now);
    expect(s.missedSyncCount).toBe(0);
    expect(s.propertyType).toBe("Single Family");
  });

  it("marks non-active statuses as not active", () => {
    const now = new Date("2026-07-07T00:00:00Z");
    expect(toScreenableListing(listing({ status: "Sold" }), now).isActive).toBe(false);
  });
});

describe("extractPriceHistory", () => {
  it("flattens date-keyed history oldest→newest and appends the current price", () => {
    const h = extractPriceHistory(
      listing({
        price: 674_000,
        history: {
          "2024-04-05": { event: "Sale Listing", price: 655_000 },
          "2025-07-07": { event: "Sale Listing", price: 615_000 },
        },
      }),
    );
    expect(h?.map((p) => p.price)).toEqual([655_000, 615_000, 674_000]);
  });

  it("collapses consecutive identical prices (history already ends at current price)", () => {
    const h = extractPriceHistory(
      listing({ price: 500_000, history: { "2024-01-01": { price: 500_000 } } }),
    );
    expect(h?.map((p) => p.price)).toEqual([500_000]);
  });

  it("returns null when there is no usable history and no valid price to seed one", () => {
    expect(extractPriceHistory(listing({ price: 0, history: {} }))).toBeNull();
    expect(extractPriceHistory(listing({ price: 0 }))).toBeNull();
  });

  it("ignores entries without a positive price", () => {
    const h = extractPriceHistory(
      listing({ price: 400_000, history: { "2023-01-01": { event: "Listing Removed" } } }),
    );
    expect(h?.map((p) => p.price)).toEqual([400_000]);
  });
});
