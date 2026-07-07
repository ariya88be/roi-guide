/**
 * Live ingestion integration test (QA §15.G): screening + idempotent upserts.
 * Uses a MOCK RentCast client (deterministic fixtures) against the REAL database
 * via `roi_app`. Gated on APP_DATABASE_URL so it skips with no DB.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/db/schema";
import type { Database } from "@/db/client";
import type { SaleListing, RentalMarket } from "@/lib/providers/rentcast";
import { ingestZip, type IngestClient } from "./pipeline";

const APP_URL = process.env.APP_DATABASE_URL;
const live = APP_URL ? describe : describe.skip;

const RUN = `itest-ingest-${process.pid}-${Date.now()}`;
const PREFIX = `${RUN}%`;
const TEST_ZIP = "00001";
const NOW = new Date("2026-07-07T00:00:00Z");

function mk(over: Partial<SaleListing>): SaleListing {
  return {
    id: `${RUN}-x`,
    latitude: 34.06,
    longitude: -118.3,
    status: "Active",
    price: 500_000,
    propertyType: "Single Family",
    bedrooms: 2,
    listingType: "Standard",
    zipCode: TEST_ZIP,
    city: "Los Angeles",
    state: "CA",
    ...over,
  } as SaleListing;
}

const MARKET: RentalMarket = {
  zipCode: TEST_ZIP,
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

const LISTINGS: SaleListing[] = [
  mk({ id: `${RUN}-1`, propertyType: "Single Family", bedrooms: 2, hoa: { fee: 400 } }), // clean
  mk({ id: `${RUN}-2`, status: "Sold" }), // screened out
  mk({ id: `${RUN}-3`, propertyType: "Land" }), // screened out
  mk({ id: `${RUN}-4`, propertyType: "Condo", bedrooms: 1, price: 400_000 }), // clean (hoa unknown)
];

const client: IngestClient = {
  getRentalMarket: async () => MARKET,
  getSaleListings: async () => LISTINGS,
};

live("ingestZip against the live DB (QA §15.G)", () => {
  let pg: postgres.Sql;
  let db: Database;

  beforeAll(() => {
    pg = postgres(APP_URL!, { ssl: false, max: 1 });
    db = drizzle(pg, { schema });
  });

  afterAll(async () => {
    await pg`delete from properties where rentcast_id like ${PREFIX}`; // cascades to listings + computed_roi
    await pg`delete from market_snapshots where zip_code = ${TEST_ZIP}`;
    await pg.end();
  });

  async function countProps(): Promise<number> {
    const [r] = await pg`select count(*)::int as n from properties where rentcast_id like ${PREFIX}`;
    return r.n;
  }
  async function countRoi(): Promise<number> {
    const [r] = await pg`
      select count(*)::int as n from computed_roi cr
      join listings l on cr.listing_id = l.id
      join properties p on l.property_id = p.id
      where p.rentcast_id like ${PREFIX}`;
    return r.n;
  }

  it("persists only the clean listings", async () => {
    const s = await ingestZip({ client, db, zipCode: TEST_ZIP, now: NOW, snapshotDate: "2026-07-07", limit: 10 });
    expect(s.fetched).toBe(4);
    expect(s.screenedOut).toBe(2); // Sold + Land
    expect(s.skippedNoRent).toBe(0);
    expect(s.ingested).toBe(2);
    expect(await countProps()).toBe(2);
    expect(await countRoi()).toBe(2);
  });

  it("is idempotent on re-run (upserts, no duplicates)", async () => {
    const s = await ingestZip({ client, db, zipCode: TEST_ZIP, now: NOW, snapshotDate: "2026-07-07", limit: 10 });
    expect(s.ingested).toBe(2);
    expect(await countProps()).toBe(2); // still 2, not 4
    expect(await countRoi()).toBe(2);
  });

  it("wrote a bedroom-matched rent and a flagged missing HOA", async () => {
    const rows = await pg`
      select p.rentcast_id, cr.median_rent::float as rent, cr.hoa_missing
      from computed_roi cr
      join listings l on cr.listing_id = l.id
      join properties p on l.property_id = p.id
      where p.rentcast_id like ${PREFIX}
      order by p.rentcast_id`;
    const byId = Object.fromEntries(rows.map((r) => [r.rentcast_id, r]));
    expect(byId[`${RUN}-1`].rent).toBe(2000); // 2-bed segment median
    expect(byId[`${RUN}-1`].hoa_missing).toBe(false); // HOA 400 known
    expect(byId[`${RUN}-4`].rent).toBe(1600); // 1-bed segment median
    expect(byId[`${RUN}-4`].hoa_missing).toBe(true); // HOA unknown -> flagged
  });
});
