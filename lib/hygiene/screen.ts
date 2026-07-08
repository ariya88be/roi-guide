/**
 * Listing hygiene screen — decides whether a listing may be rendered.
 *
 * Brief §6.C ("Never show sold or stale listings") and §4.Q7 (exclusions).
 * The screen is conservative: a listing is rendered ONLY if it passes every
 * check. Each failure is recorded with a coded reason so the reasons are
 * testable (QA §15.D) and surfaceable ("hidden because …") rather than silent.
 *
 * Pure module: the clock is injected, so freshness checks are deterministic.
 */

import {
  ACTIVE_STATUS_TOKEN,
  KNOWN_EXCLUDED_STATUS_TOKENS,
  EXCLUDED_LISTING_TYPE_TOKENS,
  ALLOWED_PROPERTY_TYPE_TOKENS,
  IMPLIED_UNIT_COUNTS,
  LAND_PROPERTY_TYPE_TOKENS,
  MAX_MULTIFAMILY_UNITS,
  FRACTIONAL_OWNERSHIP_BROKERAGE_TOKENS,
  normalizeToken,
} from "./tokens";

export type ExclusionCode =
  | "status-not-active"
  | "excluded-listing-type"
  | "raw-land"
  | "excluded-property-type"
  | "larger-multifamily"
  | "senior-restricted"
  | "inactive-flag"
  | "stale-last-seen"
  | "missed-syncs"
  | "fractional-ownership";

export interface ExclusionReason {
  code: ExclusionCode;
  detail: string;
}

/** The fields the screen needs. Extra fields on real records are ignored. */
export interface ScreenableListing {
  status: string;
  listingType?: string | null;
  propertyType?: string | null;
  /** Known unit count (for the 2–4 multifamily cap); null/undefined = unknown. */
  unitCount?: number | null;
  /** Age-restricted (55+) community flag. */
  seniorRestricted?: boolean | null;
  /** DB activeness flag; defaults to true when omitted. */
  isActive?: boolean | null;
  /** When the listing was last confirmed present in the provider feed. */
  lastSeen?: Date | null;
  /** Consecutive syncs the listing was absent from the feed. */
  missedSyncCount?: number | null;
  /** Listing office/agent name, website, and email — all six checked against
   * known fractional/co-ownership brokerages (e.g. Pacaso). RentCast exposes
   * name/website/email on BOTH office and agent, so we screen every one; a
   * fractional brokerage can surface on any of them. */
  listingOfficeName?: string | null;
  listingOfficeWebsite?: string | null;
  listingOfficeEmail?: string | null;
  listingAgentName?: string | null;
  listingAgentWebsite?: string | null;
  listingAgentEmail?: string | null;
}

export interface HygieneConfig {
  /** Render only if lastSeen is within this many days of `now`. */
  staleAfterDays: number;
  /** Render only if missedSyncCount is strictly below this. */
  maxMissedSyncs: number;
}

export const DEFAULT_HYGIENE_CONFIG: Readonly<HygieneConfig> = Object.freeze({
  staleAfterDays: 14,
  maxMissedSyncs: 2,
});

export interface HygieneResult {
  render: boolean;
  reasons: ExclusionReason[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

function checkStatus(status: string): ExclusionReason | null {
  const token = normalizeToken(status);
  if (token === ACTIVE_STATUS_TOKEN) return null;
  const label = KNOWN_EXCLUDED_STATUS_TOKENS.has(token) ? status : `${status} (non-active)`;
  return { code: "status-not-active", detail: `Listing status is "${label}", not Active.` };
}

function checkListingType(listingType?: string | null): ExclusionReason | null {
  if (!listingType) return null;
  const token = normalizeToken(listingType);
  if (EXCLUDED_LISTING_TYPE_TOKENS.has(token)) {
    return { code: "excluded-listing-type", detail: `Listing type "${listingType}" is excluded.` };
  }
  return null;
}

function checkPropertyType(propertyType?: string | null, unitCount?: number | null): ExclusionReason | null {
  // Unknown property type -> exclude (allowlist, conservative).
  if (!propertyType) {
    return { code: "excluded-property-type", detail: "Property type is unknown; excluded by allowlist." };
  }
  const token = normalizeToken(propertyType);

  if (LAND_PROPERTY_TYPE_TOKENS.has(token)) {
    return { code: "raw-land", detail: `Property type "${propertyType}" is raw land.` };
  }
  if (!ALLOWED_PROPERTY_TYPE_TOKENS.has(token)) {
    return { code: "excluded-property-type", detail: `Property type "${propertyType}" is not an included type.` };
  }

  // Enforce the 2–4 unit cap for multifamily, using either the record's unit
  // count or the count implied by the type name.
  const impliedUnits = IMPLIED_UNIT_COUNTS[token];
  const effectiveUnits = unitCount ?? impliedUnits;
  if (effectiveUnits != null && effectiveUnits > MAX_MULTIFAMILY_UNITS) {
    return {
      code: "larger-multifamily",
      detail: `${effectiveUnits}-unit multifamily exceeds the ${MAX_MULTIFAMILY_UNITS}-unit cap (deferred).`,
    };
  }
  return null;
}

/**
 * A fractional/co-ownership listing (Pacaso and similar) sells a SHARE of the
 * home — the price is not what it costs to own (or rent out) the whole unit,
 * so it must never enter the cash-flow engine as if it were a normal sale.
 * Matched by substring against the normalised office name/website/agent email
 * since real values are punctuated ("Pacaso Inc.", "mls@pacaso.com").
 */
function checkFractionalOwnership(listing: ScreenableListing): ExclusionReason | null {
  const candidates = [
    listing.listingOfficeName,
    listing.listingOfficeWebsite,
    listing.listingOfficeEmail,
    listing.listingAgentName,
    listing.listingAgentWebsite,
    listing.listingAgentEmail,
  ];
  for (const raw of candidates) {
    if (!raw) continue;
    const token = normalizeToken(raw);
    for (const brokerage of FRACTIONAL_OWNERSHIP_BROKERAGE_TOKENS) {
      if (token.includes(brokerage)) {
        return {
          code: "fractional-ownership",
          detail: `Listed by a fractional/co-ownership brokerage ("${raw}") — the price buys a share of the home, not the whole property.`,
        };
      }
    }
  }
  return null;
}

function checkFreshness(listing: ScreenableListing, config: HygieneConfig, now: Date): ExclusionReason[] {
  const reasons: ExclusionReason[] = [];

  if (listing.isActive === false) {
    reasons.push({ code: "inactive-flag", detail: "Listing is marked inactive." });
  }
  if ((listing.missedSyncCount ?? 0) >= config.maxMissedSyncs) {
    reasons.push({
      code: "missed-syncs",
      detail: `Absent from the last ${listing.missedSyncCount} syncs (limit ${config.maxMissedSyncs}).`,
    });
  }
  if (listing.lastSeen != null) {
    const ageDays = (now.getTime() - listing.lastSeen.getTime()) / DAY_MS;
    if (ageDays > config.staleAfterDays) {
      reasons.push({
        code: "stale-last-seen",
        detail: `Last verified ${Math.floor(ageDays)}d ago (stale after ${config.staleAfterDays}d).`,
      });
    }
  }
  return reasons;
}

/**
 * Screen a single listing. Returns `render: true` only when it clears every
 * hygiene check; otherwise `render: false` with the specific reasons.
 */
export function screenListing(
  listing: ScreenableListing,
  now: Date,
  config: HygieneConfig = DEFAULT_HYGIENE_CONFIG,
): HygieneResult {
  const reasons: ExclusionReason[] = [];

  const statusReason = checkStatus(listing.status);
  if (statusReason) reasons.push(statusReason);

  const typeReason = checkListingType(listing.listingType);
  if (typeReason) reasons.push(typeReason);

  const propReason = checkPropertyType(listing.propertyType, listing.unitCount);
  if (propReason) reasons.push(propReason);

  if (listing.seniorRestricted === true) {
    reasons.push({ code: "senior-restricted", detail: "Age-restricted (55+) community." });
  }

  const fractionalReason = checkFractionalOwnership(listing);
  if (fractionalReason) reasons.push(fractionalReason);

  reasons.push(...checkFreshness(listing, config, now));

  return { render: reasons.length === 0, reasons };
}

/** Partition a batch into what may be rendered and what is excluded (with reasons). */
export function screenListings<T extends ScreenableListing>(
  listings: readonly T[],
  now: Date,
  config: HygieneConfig = DEFAULT_HYGIENE_CONFIG,
): { rendered: T[]; excluded: Array<{ listing: T; reasons: ExclusionReason[] }> } {
  const rendered: T[] = [];
  const excluded: Array<{ listing: T; reasons: ExclusionReason[] }> = [];
  for (const listing of listings) {
    const result = screenListing(listing, now, config);
    if (result.render) rendered.push(listing);
    else excluded.push({ listing, reasons: result.reasons });
  }
  return { rendered, excluded };
}
