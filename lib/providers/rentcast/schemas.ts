/**
 * Zod schemas for the RentCast responses we consume.
 *
 * Brief §9: "Validate ... every input with Zod" — that includes data coming
 * back from third parties. We validate the fields our engine relies on and
 * tolerate unknown extras (`.catchall`) so a provider adding a field never
 * breaks ingestion. If a field we DEPEND on is missing or the wrong type, the
 * client throws a RentCastValidationError rather than silently passing bad data
 * into the ROI maths.
 */

import { z } from "zod";

/** Per-bedroom breakdown inside a market's rental data. */
export const BedroomRentalStatsSchema = z
  .object({
    bedrooms: z.number(),
    averageRent: z.number().optional(),
    medianRent: z.number().optional(),
    minRent: z.number().optional(),
    maxRent: z.number().optional(),
    totalListings: z.number().optional(),
  })
  .catchall(z.unknown());

/** GET /v1/markets?...&dataType=Rental */
export const RentalMarketSchema = z
  .object({
    id: z.string().optional(),
    zipCode: z.string(),
    rentalData: z
      .object({
        averageRent: z.number(),
        medianRent: z.number(),
        minRent: z.number().optional(),
        maxRent: z.number().optional(),
        averageRentPerSquareFoot: z.number().optional(),
        medianRentPerSquareFoot: z.number().optional(),
        averageSquareFootage: z.number().optional(),
        medianSquareFootage: z.number().optional(),
        averageDaysOnMarket: z.number().optional(),
        totalListings: z.number().optional(),
        lastUpdatedDate: z.string().optional(),
        dataByBedrooms: z.array(BedroomRentalStatsSchema).optional(),
      })
      .catchall(z.unknown()),
  })
  .catchall(z.unknown());

export type RentalMarket = z.infer<typeof RentalMarketSchema>;

/** HOA sub-object on a listing (RentCast returns `{ fee }` or null/absent). */
export const HoaSchema = z.object({ fee: z.number() }).catchall(z.unknown());

/**
 * Listing agent/office sub-object. Used by the hygiene screen to detect
 * fractional/co-ownership brokerages (e.g. Pacaso) — their listing price is
 * for a FRACTION of the home (e.g. 1/8th), not the whole property, which
 * silently invalidates the entire cash-flow calculation if treated as a
 * normal fee-simple sale (see lib/hygiene/tokens.ts).
 */
export const ListingContactSchema = z
  .object({
    name: z.string().optional(),
    phone: z.string().optional(),
    email: z.string().optional(),
    website: z.string().optional(),
  })
  .catchall(z.unknown());

/**
 * A single for-sale listing. GET /v1/listings/sale returns an array of these.
 * Only lat/long, price, status and identity are required; property attributes
 * are optional because real records are patchy — the engine flags what's
 * missing rather than assuming.
 */
export const SaleListingSchema = z
  .object({
    id: z.string(),
    formattedAddress: z.string().optional(),
    addressLine1: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    zipCode: z.string().optional(),
    latitude: z.number(),
    longitude: z.number(),
    propertyType: z.string().optional(),
    bedrooms: z.number().optional(),
    bathrooms: z.number().optional(),
    squareFootage: z.number().optional(),
    lotSize: z.number().optional(),
    yearBuilt: z.number().optional(),
    /** e.g. "Active", "Pending", "Sold" — drives hygiene filtering (§6.C). */
    status: z.string(),
    /** e.g. "Standard", "New Construction", "Foreclosure" — drives exclusions. */
    listingType: z.string().optional(),
    price: z.number(),
    listedDate: z.string().optional(),
    removedDate: z.string().nullish(),
    lastSeenDate: z.string().optional(),
    daysOnMarket: z.number().optional(),
    hoa: HoaSchema.nullish(),
    listingAgent: ListingContactSchema.nullish(),
    listingOffice: ListingContactSchema.nullish(),
    // RentCast returns prior list/sale events keyed by date, each with a price
    // — the source for the price-history sparkline (see mapRentcast.extractPriceHistory).
    history: z
      .record(z.string(), z.object({ event: z.string().optional(), price: z.number().optional() }).catchall(z.unknown()))
      .nullish(),
  })
  .catchall(z.unknown());

export type SaleListing = z.infer<typeof SaleListingSchema>;

export const SaleListingsSchema = z.array(SaleListingSchema);

/**
 * A rent comparable inside an AVM response. RentCast reports the comp's rent in
 * `price`, its straight-line `distance` (miles), `daysOld`, and a `correlation`
 * (match quality 0..1).
 */
export const RentComparableSchema = z
  .object({
    id: z.string().optional(),
    formattedAddress: z.string().optional(),
    latitude: z.number().optional(),
    longitude: z.number().optional(),
    price: z.number(),
    bedrooms: z.number().optional(),
    bathrooms: z.number().optional(),
    squareFootage: z.number().optional(),
    distance: z.number().optional(),
    daysOld: z.number().optional(),
    correlation: z.number().optional(),
  })
  .catchall(z.unknown());

export type RentComparable = z.infer<typeof RentComparableSchema>;

/** GET /v1/avm/rent/long-term — RentCast's rent AVM with its comps. */
export const RentEstimateSchema = z
  .object({
    rent: z.number(),
    rentRangeLow: z.number().optional(),
    rentRangeHigh: z.number().optional(),
    latitude: z.number().optional(),
    longitude: z.number().optional(),
    comparables: z.array(RentComparableSchema).optional(),
  })
  .catchall(z.unknown());

export type RentEstimate = z.infer<typeof RentEstimateSchema>;
