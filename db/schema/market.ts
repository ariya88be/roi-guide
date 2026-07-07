/**
 * Market-data tables: the ingested source of truth (not user-owned).
 *
 * Geospatial columns use PostGIS `geometry(Point, 4326)` with GiST indexes so
 * viewport bounding-box and nearest-comp queries are index-backed (brief §11,
 * QA §15.H). Raw lat/long are kept alongside the geometry for convenience.
 *
 * Money is `numeric` (never float) to avoid rounding drift. HOA is nullable on
 * purpose: NULL means "unknown" and must be flagged downstream — never a silent
 * $0 (brief §2.4).
 */

import {
  pgTable,
  uuid,
  text,
  integer,
  numeric,
  boolean,
  timestamp,
  date,
  geometry,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/** A physical property (deduped across listings over time). */
export const properties = pgTable(
  "properties",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Provider (RentCast) property id — dedupe key. */
    rentcastId: text("rentcast_id").notNull(),
    formattedAddress: text("formatted_address"),
    addressLine1: text("address_line1"),
    city: text("city"),
    state: text("state"),
    zipCode: text("zip_code"),
    latitude: numeric("latitude", { precision: 9, scale: 6 }),
    longitude: numeric("longitude", { precision: 9, scale: 6 }),
    location: geometry("location", { type: "point", mode: "xy", srid: 4326 }).notNull(),
    propertyType: text("property_type"),
    bedrooms: numeric("bedrooms", { precision: 3, scale: 1 }),
    bathrooms: numeric("bathrooms", { precision: 3, scale: 1 }),
    squareFootage: integer("square_footage"),
    lotSize: integer("lot_size"),
    yearBuilt: integer("year_built"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("properties_rentcast_id_key").on(t.rentcastId),
    index("properties_zip_idx").on(t.zipCode),
    index("properties_location_gix").using("gist", t.location),
  ],
);

/**
 * A for-sale listing's state over time. `status`/`listingType` drive hygiene
 * filtering and exclusions (brief §6.C). `firstSeen`/`lastSeen` + `missedSyncCount`
 * implement "mark inactive if absent from the last N syncs".
 */
export const listings = pgTable(
  "listings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => properties.id, { onDelete: "cascade" }),
    source: text("source").notNull().default("rentcast"),
    /** Raw provider status, e.g. Active / Pending / Sold / Contingent. */
    status: text("status").notNull(),
    /** e.g. Standard / New Construction / Foreclosure — drives exclusions. */
    listingType: text("listing_type"),
    price: numeric("price", { precision: 12, scale: 2 }).notNull(),
    /** NULL = HOA unknown (flag + lower confidence). 0 = confirmed no HOA. */
    hoaFee: numeric("hoa_fee", { precision: 10, scale: 2 }),
    listedDate: date("listed_date"),
    removedDate: date("removed_date"),
    firstSeen: timestamp("first_seen", { withTimezone: true }).defaultNow().notNull(),
    lastSeen: timestamp("last_seen", { withTimezone: true }).defaultNow().notNull(),
    /** Only Active + fresh listings are ever rendered (brief §6.C). */
    isActive: boolean("is_active").notNull().default(true),
    /** Consecutive sync cycles this listing was absent from the provider feed. */
    missedSyncCount: integer("missed_sync_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // One current listing per property per source — the idempotent-upsert key.
    uniqueIndex("listings_property_source_key").on(t.propertyId, t.source),
    index("listings_status_idx").on(t.status),
    index("listings_active_idx").on(t.isActive),
  ],
);

/** Comparable rentals supporting a subject property's median-rent estimate. */
export const rentComps = pgTable(
  "rent_comps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => properties.id, { onDelete: "cascade" }),
    rent: numeric("rent", { precision: 10, scale: 2 }).notNull(),
    location: geometry("location", { type: "point", mode: "xy", srid: 4326 }),
    bedrooms: numeric("bedrooms", { precision: 3, scale: 1 }),
    bathrooms: numeric("bathrooms", { precision: 3, scale: 1 }),
    squareFootage: integer("square_footage"),
    distanceMiles: numeric("distance_miles", { precision: 6, scale: 3 }),
    /** Recency in days — feeds the confidence score. */
    ageDays: integer("age_days").notNull(),
    correlation: numeric("correlation", { precision: 4, scale: 3 }),
    source: text("source").notNull().default("rentcast"),
    capturedAt: timestamp("captured_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("rent_comps_property_idx").on(t.propertyId),
    index("rent_comps_location_gix").using("gist", t.location),
  ],
);

/** Dated aggregate market stats per ZIP — powers months-of-supply over time. */
export const marketSnapshots = pgTable(
  "market_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    zipCode: text("zip_code").notNull(),
    snapshotDate: date("snapshot_date").notNull(),
    activeRentalListings: integer("active_rental_listings"),
    averageRent: numeric("average_rent", { precision: 10, scale: 2 }),
    medianRent: numeric("median_rent", { precision: 10, scale: 2 }),
    minRent: numeric("min_rent", { precision: 10, scale: 2 }),
    maxRent: numeric("max_rent", { precision: 10, scale: 2 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("market_snapshots_zip_date_key").on(t.zipCode, t.snapshotDate)],
);

/**
 * Precomputed ROI per active listing under CONSERVATIVE DEFAULT assumptions —
 * this is what colours the map. User-adjusted assumptions (sliders) are
 * recomputed on the fly by the pure ROI engine; only the default result is
 * persisted. `assumptionsHash` records which assumption set produced the row so
 * stale rows can be recomputed when defaults change.
 */
export const computedRoi = pgTable(
  "computed_roi",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    listingId: uuid("listing_id")
      .notNull()
      .references(() => listings.id, { onDelete: "cascade" }),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => properties.id, { onDelete: "cascade" }),
    medianRent: numeric("median_rent", { precision: 10, scale: 2 }).notNull(),
    avmRent: numeric("avm_rent", { precision: 10, scale: 2 }),
    monthlyCashFlow: numeric("monthly_cash_flow", { precision: 12, scale: 2 }).notNull(),
    /** below | meets | comfortable | strong (matches lib/roi/color Band). */
    colorBand: text("color_band").notNull(),
    confidenceScore: integer("confidence_score").notNull(),
    confidenceLevel: text("confidence_level").notNull(),
    deEmphasize: boolean("de_emphasize").notNull().default(false),
    hoaMissing: boolean("hoa_missing").notNull().default(false),
    taxEstimated: boolean("tax_estimated").notNull().default(false),
    insuranceEstimated: boolean("insurance_estimated").notNull().default(false),
    assumptionsHash: text("assumptions_hash").notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("computed_roi_listing_key").on(t.listingId),
    index("computed_roi_property_idx").on(t.propertyId),
    index("computed_roi_band_idx").on(t.colorBand),
  ],
);
