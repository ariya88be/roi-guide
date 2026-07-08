/**
 * Ingestion orchestrator: RentCast → hygiene screen → ROI compute → persist.
 *
 * The client and database are injected so the whole flow is testable with a mock
 * client (unit-ish) and a live database (integration). `now`/`snapshotDate` are
 * passed in to keep the run deterministic.
 */

import { screenListing } from "@/lib/hygiene";
import type { Database } from "@/db/client";
import type { SaleListing, RentalMarket } from "@/lib/providers/rentcast";
import { toScreenableListing, pickBedroomMedianRent } from "./mapRentcast";
import { computeListingRoi } from "./compute";
import { upsertProperty, upsertListing, upsertComputedRoi, upsertMarketSnapshot } from "./persist";

/** The subset of the RentCast client the pipeline needs (RentCastClient satisfies it). */
export interface IngestClient {
  getRentalMarket(zipCode: string): Promise<RentalMarket>;
  getSaleListings(params: {
    zipCode?: string;
    status?: string;
    limit?: number;
    offset?: number;
    latitude?: number;
    longitude?: number;
    radius?: number;
  }): Promise<SaleListing[]>;
}

export interface IngestSummary {
  zipCode: string;
  /** Listings returned by the provider. */
  fetched: number;
  /** Removed by the hygiene screen (sold/stale/distressed/wrong-type). */
  screenedOut: number;
  /** Passed hygiene but the market had no usable rent figure. */
  skippedNoRent: number;
  /** Persisted (property + listing + computed ROI). */
  ingested: number;
}

export interface IngestZipParams {
  client: IngestClient;
  db: Database;
  zipCode: string;
  now: Date;
  /** 'YYYY-MM-DD' for the market snapshot row. */
  snapshotDate: string;
  /** Max listings to pull from the provider. */
  limit?: number;
}

/**
 * Ingest one ZIP end to end. Costs two provider calls (one market, one
 * listings) regardless of how many listings come back — the ZIP-median rent
 * basis avoids per-property AVM calls.
 */
export async function ingestZip(params: IngestZipParams): Promise<IngestSummary> {
  const { client, db, zipCode, now, snapshotDate, limit } = params;

  const market = await client.getRentalMarket(zipCode);
  await upsertMarketSnapshot(db, zipCode, snapshotDate, market);

  const raw = await client.getSaleListings({ zipCode, status: "Active", limit });

  let screenedOut = 0;
  let skippedNoRent = 0;
  let ingested = 0;

  for (const listing of raw) {
    const screen = screenListing(toScreenableListing(listing, now), now);
    if (!screen.render) {
      screenedOut++;
      continue;
    }

    const pick = pickBedroomMedianRent(market, listing.bedrooms);
    if (pick.rent == null) {
      skippedNoRent++;
      continue;
    }

    const roi = computeListingRoi({
      price: listing.price,
      monthlyRent: pick.rent,
      monthlyHoa: listing.hoa?.fee ?? null,
      sampleSize: pick.sampleSize,
    });

    const propertyId = await upsertProperty(db, listing);
    const listingId = await upsertListing(db, propertyId, listing, now);
    await upsertComputedRoi(db, listingId, propertyId, roi);
    ingested++;
  }

  return { zipCode, fetched: raw.length, screenedOut, skippedNoRent, ingested };
}

/**
 * Mountain + high-desert vacation-cabin markets NE of San Bernardino. Their
 * long-term-rent medians are thin/unreliable (short-term/vacation economies), so
 * they don't belong in a buy-and-hold cash-flow tool. Excluded by default.
 */
export const DEFAULT_EXCLUDED_MARKETS = new Set(
  [
    "Big Bear Lake",
    "Big Bear City",
    "Lake Arrowhead",
    "Crestline",
    "Running Springs",
    "Green Valley Lake",
    "Fawnskin",
    "Angelus Oaks",
    "Sugarloaf",
    "Blue Jay",
    "Cedar Glen",
    "Twin Peaks",
    "Rimforest",
    "Wrightwood",
    "Hesperia",
    "Apple Valley",
    "Victorville",
    "Adelanto",
    "Phelan",
    "Oak Hills",
    "Pinon Hills",
    "Lucerne Valley",
    "Yucca Valley",
    "Joshua Tree",
    "Landers",
    "Forest Falls",
    "Mount Baldy",
  ].map((c) => c.toLowerCase()),
);

export interface IngestRadiusParams {
  client: IngestClient;
  db: Database;
  center: { lat: number; lng: number };
  radiusMiles: number;
  now: Date;
  snapshotDate: string;
  /** Only ingest listings at or below this price (client-side; provider has no price filter). */
  maxPrice?: number | null;
  /** Cities to skip (vacation/desert). Defaults to {@link DEFAULT_EXCLUDED_MARKETS}. */
  excludeCities?: Set<string>;
  /** Listings per page. */
  pageSize?: number;
  /** Safety cap on total listings pulled. */
  maxListings?: number;
  /**
   * Cap on how many ZIPs we fetch rent-market data for (one call each). We take
   * the ZIPs with the most inventory first; listings in un-fetched ZIPs are
   * skipped (no rent basis) — this bounds API cost on the free/low tiers.
   */
  maxMarketZips?: number;
}

export interface RadiusSummary {
  /** Active listings the radius returned. */
  fetched: number;
  /** Of those, at or below the price cap. */
  belowPriceCap: number;
  screenedOut: number;
  skippedNoRent: number;
  ingested: number;
  /** Listings that threw during compute/persist (e.g. bad price) and were skipped. */
  errored: number;
  /** ZIPs we pulled market data for. */
  zipsWithMarket: number;
  /** ZIPs with inventory we skipped to stay in budget. */
  zipsSkipped: number;
  /** RentCast calls this run made (listings pages + market ZIPs). */
  approxApiCalls: number;
}

/**
 * Ingest every active listing within `radiusMiles` of a point (RentCast supports
 * lat/long/radius natively — no ZIP enumeration). Rent basis is each listing's
 * ZIP bedroom-matched median, fetched only for the highest-inventory ZIPs to
 * bound API cost. Resilient: a failed market call skips that ZIP, not the run.
 */
export async function ingestRadius(params: IngestRadiusParams): Promise<RadiusSummary> {
  const {
    client,
    db,
    center,
    radiusMiles,
    now,
    snapshotDate,
    maxPrice = null,
    pageSize = 500,
    maxListings = 3000,
    maxMarketZips = 25,
    excludeCities = DEFAULT_EXCLUDED_MARKETS,
  } = params;

  // 1. Paginate listings within the radius.
  const all: SaleListing[] = [];
  let offset = 0;
  let pages = 0;
  while (all.length < maxListings) {
    let page: SaleListing[];
    try {
      page = await client.getSaleListings({
        latitude: center.lat,
        longitude: center.lng,
        radius: radiusMiles,
        status: "Active",
        limit: pageSize,
        offset,
      });
    } catch {
      break; // quota/network — proceed with what we have
    }
    pages++;
    all.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }

  // 2. Price cap + drop excluded (vacation/desert) markets before spending calls.
  const priced = all.filter(
    (l) =>
      (maxPrice == null || l.price <= maxPrice) &&
      !(l.city && excludeCities.has(l.city.trim().toLowerCase())),
  );

  // 3. Group by ZIP; fetch market for the highest-inventory ZIPs only.
  const byZip = new Map<string, SaleListing[]>();
  for (const l of priced) {
    if (!l.zipCode) continue;
    const bucket = byZip.get(l.zipCode);
    if (bucket) bucket.push(l);
    else byZip.set(l.zipCode, [l]);
  }
  const zipsByInventory = [...byZip.entries()].sort((a, b) => b[1].length - a[1].length);
  const marketZips = zipsByInventory.slice(0, maxMarketZips).map(([z]) => z);

  const marketByZip = new Map<string, RentalMarket>();
  for (const zip of marketZips) {
    try {
      const market = await client.getRentalMarket(zip);
      marketByZip.set(zip, market);
      await upsertMarketSnapshot(db, zip, snapshotDate, market);
    } catch {
      // Skip this ZIP's listings rather than abort the whole run (e.g. quota).
    }
  }

  // 4. Screen, price rent, compute ROI, persist.
  let screenedOut = 0;
  let skippedNoRent = 0;
  let ingested = 0;
  let errored = 0;
  for (const listing of priced) {
    const screen = screenListing(toScreenableListing(listing, now), now);
    if (!screen.render) {
      screenedOut++;
      continue;
    }
    const market = listing.zipCode ? marketByZip.get(listing.zipCode) : undefined;
    if (!market) {
      skippedNoRent++;
      continue;
    }
    const pick = pickBedroomMedianRent(market, listing.bedrooms);
    if (pick.rent == null) {
      skippedNoRent++;
      continue;
    }
    try {
      const roi = computeListingRoi({
        price: listing.price,
        monthlyRent: pick.rent,
        monthlyHoa: listing.hoa?.fee ?? null,
        sampleSize: pick.sampleSize,
      });
      const propertyId = await upsertProperty(db, listing);
      const listingId = await upsertListing(db, propertyId, listing, now);
      await upsertComputedRoi(db, listingId, propertyId, roi);
      ingested++;
    } catch {
      // One malformed listing (e.g. non-positive price) must not abort the run.
      errored++;
    }
  }

  return {
    fetched: all.length,
    belowPriceCap: priced.length,
    screenedOut,
    skippedNoRent,
    ingested,
    errored,
    zipsWithMarket: marketByZip.size,
    zipsSkipped: byZip.size - marketByZip.size,
    approxApiCalls: pages + marketByZip.size,
  };
}
