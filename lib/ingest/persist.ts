/**
 * Idempotent persistence for ingested market data (QA §15.G).
 *
 * All writes are upserts keyed on a business identity, so re-running ingestion
 * updates rows in place instead of duplicating them. Geometry is written with an
 * explicit `ST_SetSRID(ST_MakePoint(lng,lat),4326)` so the SRID is never
 * ambiguous. Numeric columns are passed as strings to preserve precision
 * (postgres `numeric` <-> JS string).
 *
 * These are market tables (no RLS); the runtime `roi_app` role has DML grants.
 */

import { sql } from "drizzle-orm";
import { normalizeToken } from "@/lib/hygiene";
import { properties, listings, computedRoi, marketSnapshots } from "@/db/schema";
import type { Database } from "@/db/client";
import type { SaleListing, RentalMarket } from "@/lib/providers/rentcast";
import type { ComputedRoiRecord } from "./compute";

const numOrNull = (n: number | null | undefined): string | null => (n == null ? null : String(n));

/** Insert or update a property by its RentCast id. Returns the property id. */
export async function upsertProperty(db: Database, l: SaleListing): Promise<string> {
  const geom = sql`ST_SetSRID(ST_MakePoint(${l.longitude}, ${l.latitude}), 4326)`;
  const [row] = await db
    .insert(properties)
    .values({
      rentcastId: l.id,
      location: geom,
      formattedAddress: l.formattedAddress ?? null,
      addressLine1: l.addressLine1 ?? null,
      city: l.city ?? null,
      state: l.state ?? null,
      zipCode: l.zipCode ?? null,
      latitude: numOrNull(l.latitude),
      longitude: numOrNull(l.longitude),
      propertyType: l.propertyType ?? null,
      bedrooms: numOrNull(l.bedrooms),
      bathrooms: numOrNull(l.bathrooms),
      squareFootage: l.squareFootage ?? null,
      lotSize: l.lotSize ?? null,
      yearBuilt: l.yearBuilt ?? null,
    })
    .onConflictDoUpdate({
      target: properties.rentcastId,
      set: {
        location: geom,
        propertyType: l.propertyType ?? null,
        bedrooms: numOrNull(l.bedrooms),
        bathrooms: numOrNull(l.bathrooms),
        squareFootage: l.squareFootage ?? null,
        updatedAt: sql`now()`,
      },
    })
    .returning({ id: properties.id });
  return row.id;
}

/** Insert or update the current listing for a property. Returns the listing id. */
export async function upsertListing(
  db: Database,
  propertyId: string,
  l: SaleListing,
  now: Date,
): Promise<string> {
  const isActive = normalizeToken(l.status) === "active";
  const listedDate = l.listedDate ? l.listedDate.slice(0, 10) : null;
  const [row] = await db
    .insert(listings)
    .values({
      propertyId,
      source: "rentcast",
      status: l.status,
      listingType: l.listingType ?? null,
      price: String(l.price),
      hoaFee: numOrNull(l.hoa?.fee),
      listedDate,
      firstSeen: now,
      lastSeen: now,
      isActive,
      missedSyncCount: 0,
    })
    .onConflictDoUpdate({
      target: [listings.propertyId, listings.source],
      set: {
        status: l.status,
        listingType: l.listingType ?? null,
        price: String(l.price),
        hoaFee: numOrNull(l.hoa?.fee),
        lastSeen: now, // firstSeen is intentionally NOT touched on update
        isActive,
        missedSyncCount: 0,
        updatedAt: sql`now()`,
      },
    })
    .returning({ id: listings.id });
  return row.id;
}

/** Insert or update the computed ROI for a listing. */
export async function upsertComputedRoi(
  db: Database,
  listingId: string,
  propertyId: string,
  roi: ComputedRoiRecord,
): Promise<void> {
  const set = {
    medianRent: String(roi.medianRent),
    avmRent: numOrNull(roi.avmRent),
    monthlyCashFlow: String(roi.monthlyCashFlow),
    colorBand: roi.cashFlowSign, // absolute sign; render colour is target-relative
    confidenceScore: roi.confidenceScore,
    confidenceLevel: roi.confidenceLevel,
    deEmphasize: roi.deEmphasize,
    hoaMissing: roi.hoaMissing,
    taxEstimated: roi.taxEstimated,
    insuranceEstimated: roi.insuranceEstimated,
    assumptionsHash: roi.assumptionsHash,
  };
  await db
    .insert(computedRoi)
    .values({ listingId, propertyId, ...set })
    .onConflictDoUpdate({ target: computedRoi.listingId, set: { ...set, computedAt: sql`now()` } });
}

/** Insert or update a dated market snapshot for a ZIP (months-of-supply source). */
export async function upsertMarketSnapshot(
  db: Database,
  zipCode: string,
  snapshotDate: string,
  market: RentalMarket,
): Promise<void> {
  const rd = market.rentalData;
  const set = {
    activeRentalListings: rd.totalListings ?? null,
    averageRent: String(rd.averageRent),
    medianRent: String(rd.medianRent),
    minRent: numOrNull(rd.minRent),
    maxRent: numOrNull(rd.maxRent),
    // Stored verbatim so a cache HIT can still bedroom-match (see getCachedOrLiveMarket).
    dataByBedrooms: rd.dataByBedrooms ?? null,
  };
  await db
    .insert(marketSnapshots)
    .values({ zipCode, snapshotDate, ...set })
    .onConflictDoUpdate({ target: [marketSnapshots.zipCode, marketSnapshots.snapshotDate], set });
}
