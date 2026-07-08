/**
 * Pure mappers from RentCast API shapes into our domain inputs.
 *
 * Kept free of I/O so they are exhaustively unit-testable. The pipeline
 * (pipeline.ts) wires these to the live client and database.
 */

import { normalizeToken } from "@/lib/hygiene";
import type { ScreenableListing } from "@/lib/hygiene";
import type { SaleListing, RentalMarket } from "@/lib/providers/rentcast";

/**
 * Map a RentCast for-sale listing into the hygiene screen's input shape.
 * A just-fetched listing is "seen now"; activeness is derived from status.
 */
export function toScreenableListing(listing: SaleListing, now: Date): ScreenableListing {
  return {
    status: listing.status,
    listingType: listing.listingType ?? null,
    propertyType: listing.propertyType ?? null,
    unitCount: null, // RentCast sale listings don't expose unit count in Phase 1
    seniorRestricted: false, // not available from this feed; refined in Phase 2
    isActive: normalizeToken(listing.status) === "active",
    lastSeen: now,
    missedSyncCount: 0,
    listingOfficeName: listing.listingOffice?.name ?? null,
    listingOfficeWebsite: listing.listingOffice?.website ?? null,
    listingOfficeEmail: listing.listingOffice?.email ?? null,
    listingAgentName: listing.listingAgent?.name ?? null,
    listingAgentWebsite: listing.listingAgent?.website ?? null,
    listingAgentEmail: listing.listingAgent?.email ?? null,
  };
}

/** One point on the price-history sparkline. */
export interface PricePoint {
  date: string;
  price: number;
}

/**
 * Flatten RentCast's date-keyed listing `history` into a compact, oldest→newest
 * price series for the sparkline. Keeps only entries with a positive price,
 * de-dupes identical consecutive prices, and always appends the CURRENT list
 * price as the latest point so the line ends at what the map shows. Returns
 * null when there isn't at least one point (nothing to draw).
 */
export function extractPriceHistory(listing: SaleListing): PricePoint[] | null {
  const points: PricePoint[] = [];
  const hist = listing.history ?? {};
  for (const [date, entry] of Object.entries(hist)) {
    const price = entry?.price;
    if (typeof price === "number" && price > 0) points.push({ date, price });
  }
  points.sort((a, b) => a.date.localeCompare(b.date));
  // Ensure the newest point is the current list price (history may lag).
  if (typeof listing.price === "number" && listing.price > 0) {
    const last = points[points.length - 1];
    if (!last || last.price !== listing.price) {
      points.push({ date: listing.lastSeenDate ?? listing.listedDate ?? "current", price: listing.price });
    }
  }
  // Collapse runs of identical prices to keep the line honest and minimal.
  const deduped = points.filter((p, i) => i === 0 || p.price !== points[i - 1].price);
  return deduped.length > 0 ? deduped : null;
}

export interface RentPick {
  /** Chosen monthly rent basis, or null if the market has no usable figure. */
  rent: number | null;
  /** Sample size behind the chosen figure (for a coarse confidence). */
  sampleSize: number | null;
  /** True when we used the bedroom-matched segment rather than the ZIP overall. */
  bedroomMatched: boolean;
}

/**
 * Phase-1 rent basis: the ZIP market MEDIAN rent, matched to the property's
 * bedroom count when RentCast provides a per-bedroom breakdown, else the ZIP
 * overall median. This costs ONE market call per ZIP (vs. one AVM call per
 * property), keeping us inside the free-tier budget. Full property-level
 * median-of-comps + confidence is Phase 2.
 */
export function pickBedroomMedianRent(market: RentalMarket, bedrooms?: number | null): RentPick {
  const rd = market.rentalData;
  const beds = bedrooms == null ? null : Math.round(bedrooms);

  if (beds != null && rd.dataByBedrooms) {
    const seg = rd.dataByBedrooms.find((d) => d.bedrooms === beds);
    // MEDIAN only — never silently substitute the mean under the "median" name
    // (the whole point of the median basis is to resist the outlier a mean
    // absorbs). If this segment has no median, fall through to the ZIP overall.
    const segRent = seg?.medianRent ?? null;
    if (segRent != null) {
      return { rent: segRent, sampleSize: seg?.totalListings ?? null, bedroomMatched: true };
    }
  }
  return { rent: rd.medianRent ?? null, sampleSize: rd.totalListings ?? null, bedroomMatched: false };
}
