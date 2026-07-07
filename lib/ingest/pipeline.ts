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
