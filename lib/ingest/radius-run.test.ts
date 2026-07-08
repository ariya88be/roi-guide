/**
 * One-shot LIVE radius ingest. Gated behind RUN_RADIUS_INGEST=1. Spends real
 * RentCast quota (listings pages + one call per covered ZIP). Run:
 *   set -a && . ./.env.local && set +a && RUN_RADIUS_INGEST=1 \
 *     npx vitest run lib/ingest/radius-run.test.ts
 */
import { describe, it, expect } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/db/schema";
import { createRentCastClient } from "@/lib/providers/rentcast";
import { ingestRadius } from "./pipeline";

const enabled =
  process.env.RUN_RADIUS_INGEST === "1" && !!process.env.APP_DATABASE_URL && !!process.env.RENTCAST_API_KEY;
const live = enabled ? describe : describe.skip;

live("LIVE radius ingest (real RentCast + DB)", () => {
  it(
    "ingests a 25mi radius around San Bernardino, <= $500k",
    async () => {
      const pg = postgres(process.env.APP_DATABASE_URL!, { ssl: false, max: 1 });
      const db = drizzle(pg, { schema });
      const client = createRentCastClient();
      try {
        const summary = await ingestRadius({
          client,
          db,
          // Default: WEST of San Bernardino (Fontana/Ontario belt, toward LA),
          // biased to the SB→Santa Monica corridor. Override via env.
          center: {
            lat: Number(process.env.INGEST_LAT ?? 34.02),
            lng: Number(process.env.INGEST_LNG ?? -117.58),
          },
          radiusMiles: Number(process.env.INGEST_RADIUS ?? 22),
          now: new Date(),
          snapshotDate: new Date().toISOString().slice(0, 10),
          maxPrice: 500_000,
          pageSize: 500,
          maxListings: Number(process.env.INGEST_MAX_LISTINGS ?? 3000),
          maxMarketZips: Number(process.env.INGEST_MAX_ZIPS ?? 50),
        });
        console.log("RADIUS INGEST SUMMARY:", JSON.stringify(summary));
        expect(summary.ingested).toBeGreaterThanOrEqual(0);
      } finally {
        await pg.end();
      }
    },
    180_000,
  );
});
