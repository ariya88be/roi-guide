/**
 * One-shot LIVE ingest against real RentCast + the real DB. Gated behind
 * RUN_LIVE_INGEST=1 so it never runs in the normal suite (it spends real
 * provider quota). Run explicitly:
 *   set -a && . ./.env.local && set +a && RUN_LIVE_INGEST=1 \
 *     npx vitest run lib/ingest/live-run.test.ts
 */
import { describe, it, expect } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/db/schema";
import { createRentCastClient } from "@/lib/providers/rentcast";
import { ingestZip } from "./pipeline";

const enabled =
  process.env.RUN_LIVE_INGEST === "1" && !!process.env.APP_DATABASE_URL && !!process.env.RENTCAST_API_KEY;
const live = enabled ? describe : describe.skip;

// Default to a San Bernardino (Inland Empire) ZIP — cheaper homes with higher
// rent-to-price ratios, so the map actually shows positive cash-flow pins.
const INGEST_ZIP = process.env.INGEST_ZIP ?? "92404";

live("LIVE ingest (real RentCast + DB)", () => {
  it(
    `ingests ZIP ${INGEST_ZIP}`,
    async () => {
      const pg = postgres(process.env.APP_DATABASE_URL!, { ssl: false, max: 1 });
      const db = drizzle(pg, { schema });
      const client = createRentCastClient();
      try {
        const summary = await ingestZip({
          client,
          db,
          zipCode: INGEST_ZIP,
          now: new Date(),
          snapshotDate: new Date().toISOString().slice(0, 10),
          limit: 25,
        });
        // eslint-disable-next-line no-console
        console.log("LIVE INGEST SUMMARY:", JSON.stringify(summary));
        expect(summary.fetched).toBeGreaterThanOrEqual(0);
      } finally {
        await pg.end();
      }
    },
    60_000,
  );
});
