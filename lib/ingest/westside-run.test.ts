/**
 * One-shot LIVE radius ingest for the Westside/Valley/Coast sweep. Gated
 * behind RUN_WESTSIDE_INGEST=1. Spends real RentCast quota (listings pages +
 * one call per covered ZIP). Run:
 *   set -a && . ./.env.local && set +a && RUN_WESTSIDE_INGEST=1 \
 *     INGEST_MAX_ZIPS=0 npx vitest run lib/ingest/westside-run.test.ts   # recon (free-ish)
 *   set -a && . ./.env.local && set +a && RUN_WESTSIDE_INGEST=1 \
 *     INGEST_MAX_ZIPS=<n> npx vitest run lib/ingest/westside-run.test.ts # real pull
 *
 * A 50mi circle from West Hollywood is a simple, honest superset of the
 * owner's hand-drawn area (Valley/Hollywood/Westside/Southbay-ish) PLUS
 * Malibu and Calabasas (both comfortably inside 50mi to the west/northwest).
 * The owner's drawing clearly routed AROUND the San Gabriel Valley and the
 * industrial southeast-LA cities — since a circle can't respect that notch,
 * we exclude those specific incorporated cities by name instead (more
 * reliable than a hand-fit polygon vertex would be anyway).
 */
import { describe, it, expect } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/db/schema";
import { createRentCastClient } from "@/lib/providers/rentcast";
import { ingestRadius, DEFAULT_EXCLUDED_MARKETS } from "./pipeline";

const enabled =
  process.env.RUN_WESTSIDE_INGEST === "1" && !!process.env.APP_DATABASE_URL && !!process.env.RENTCAST_API_KEY;
const live = enabled ? describe : describe.skip;

/**
 * San Gabriel Valley + industrial-southeast-LA incorporated cities the
 * owner's drawing routed around. Distinct from DEFAULT_EXCLUDED_MARKETS
 * (mountain/desert vacation towns, not relevant here but harmless to keep).
 */
const SGV_AND_SOUTHEAST_EXCLUDED = new Set(
  [
    "San Marino",
    "Alhambra",
    "San Gabriel",
    "Monterey Park",
    "Rosemead",
    "Pico Rivera",
    "Montebello",
    "Commerce",
    "Vernon",
    "Maywood",
    "Bell",
    "Bell Gardens",
    "Huntington Park",
    "South Gate",
    "Cudahy",
    "Walnut Park",
    "East Los Angeles",
  ].map((c) => c.toLowerCase()),
);

/**
 * A 50mi circle from West Hollywood geometrically reaches well beyond
 * "westside LA + Malibu + Calabasas": over the mountains into the high desert,
 * north into Santa Clarita, south into the Harbor/South Bay, and into Orange
 * County. None of that was ever part of the intended area — exclude by name
 * since a circle can't respect direction. (Cities already wanted from the
 * earlier Inland Empire ingest — Ontario, Rancho Cucamonga, Corona, etc. —
 * are deliberately NOT here; this run's overlap with them is fine.)
 */
const OUT_OF_SCOPE_EXCLUDED = new Set(
  [
    // Antelope Valley (high desert, over the mountains)
    "Lancaster",
    "Palmdale",
    "Littlerock",
    "Lake Hughes",
    "Quartz Hill",
    "Llano",
    "Pearblossom",
    "Juniper Hills",
    "Agua Dulce",
    "Leona Valley",
    "Acton",
    "Green Valley",
    // Santa Clarita Valley
    "Valencia",
    "Canyon Country",
    "Newhall",
    "Santa Clarita",
    "Saugus",
    "Stevenson Ranch",
    "Castaic",
    // South Bay / Harbor
    "Long Beach",
    "San Pedro",
    "Torrance",
    "Gardena",
    "Compton",
    "Harbor City",
    "Paramount",
    "Bellflower",
    // Extended San Gabriel / Pomona Valley (beyond the Inland Empire already wanted)
    "Pomona",
    "Diamond Bar",
    "Azusa",
    "Baldwin Park",
    "El Monte",
    "Hacienda Heights",
    "San Dimas",
    "Duarte",
    "Walnut",
    "Claremont",
    "La Verne",
    "Rowland Heights",
    "Phillips Ranch",
    // Orange County
    "Laguna Woods",
    "Seal Beach",
    "Santa Ana",
    "Fullerton",
    "Anaheim",
    "Huntington Beach",
    "Lake Forest",
    "Costa Mesa",
    "La Habra",
    "Brea",
    "Stanton",
  ].map((c) => c.toLowerCase()),
);

const EXCLUDE = new Set([...DEFAULT_EXCLUDED_MARKETS, ...SGV_AND_SOUTHEAST_EXCLUDED, ...OUT_OF_SCOPE_EXCLUDED]);

live("LIVE westside radius ingest (real RentCast + DB)", () => {
  it(
    "ingests a 50mi radius around West Hollywood, <= $700k",
    async () => {
      const pg = postgres(process.env.APP_DATABASE_URL!, { ssl: false, max: 1 });
      const db = drizzle(pg, { schema });
      const client = createRentCastClient();
      try {
        const summary = await ingestRadius({
          client,
          db,
          center: {
            lat: Number(process.env.INGEST_LAT ?? 34.09),
            lng: Number(process.env.INGEST_LNG ?? -118.3617),
          },
          radiusMiles: Number(process.env.INGEST_RADIUS ?? 50),
          now: new Date(),
          snapshotDate: new Date().toISOString().slice(0, 10),
          maxPrice: 700_000,
          excludeCities: EXCLUDE,
          pageSize: 500,
          maxListings: Number(process.env.INGEST_MAX_LISTINGS ?? 8000),
          maxMarketZips: Number(process.env.INGEST_MAX_ZIPS ?? 100),
        });
        console.log("WESTSIDE INGEST SUMMARY:", JSON.stringify(summary));
        expect(summary.ingested).toBeGreaterThanOrEqual(0);
      } finally {
        await pg.end();
      }
    },
    900_000,
  );
});
