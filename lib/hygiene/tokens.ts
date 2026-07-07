/**
 * Normalisation + vocabulary for listing hygiene.
 *
 * Provider status/type strings vary in case, spacing, and punctuation
 * ("Under Contract", "under_contract", "Pre-Foreclosure"). We normalise to a
 * bare alphanumeric token so matching is robust, then match against explicit
 * allow/deny sets. The guiding rule (brief §6.C): only render Active, fresh,
 * non-distressed, comparable-type listings — when in doubt, EXCLUDE.
 */

/** Lowercase and strip everything but a–z/0–9: "New Construction" -> "newconstruction". */
export function normalizeToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The only for-sale status we will render. Everything else is excluded. */
export const ACTIVE_STATUS_TOKEN = "active";

/**
 * Known non-active statuses, kept for precise messaging. Any status that is not
 * `active` is excluded regardless of whether it appears here — this list only
 * improves the reason label.
 */
export const KNOWN_EXCLUDED_STATUS_TOKENS = new Set([
  "sold",
  "pending",
  "contingent",
  "undercontract",
  "offmarket",
  "comingsoon",
  "withdrawn",
  "expired",
  "canceled",
  "cancelled",
  "inactive",
]);

/** Distressed / non-comparable listing types (brief §4.Q7). */
export const EXCLUDED_LISTING_TYPE_TOKENS = new Set([
  "foreclosure",
  "preforeclosure",
  "auction",
  "reo",
  "bankowned",
  "shortsale",
  "newconstruction",
]);

/** Property types we include. Anything not here is excluded (allowlist). */
export const ALLOWED_PROPERTY_TYPE_TOKENS = new Set([
  "singlefamily",
  "condo",
  "condominium",
  "townhouse",
  "townhome",
  // 2–4 unit multifamily:
  "multifamily",
  "duplex",
  "triplex",
  "fourplex",
  "quadruplex",
]);

/** Property-type tokens that carry an implied unit count (for the 2–4 cap). */
export const IMPLIED_UNIT_COUNTS: Readonly<Record<string, number>> = {
  duplex: 2,
  triplex: 3,
  fourplex: 4,
  quadruplex: 4,
};

/** Raw-land tokens, called out for a clearer exclusion reason. */
export const LAND_PROPERTY_TYPE_TOKENS = new Set(["land", "vacantland", "lot", "vacantlot"]);

/** Max units for an included multifamily property; 5+ is deferred (brief §4.Q7). */
export const MAX_MULTIFAMILY_UNITS = 4;
