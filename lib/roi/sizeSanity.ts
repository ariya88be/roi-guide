/**
 * Square-footage sanity check for the rent basis.
 *
 * Our Phase-1 rent basis (lib/ingest/mapRentcast.pickBedroomMedianRent) matches
 * on BEDROOM COUNT only — it has no way to know a listing is unusually small for
 * that bedroom count. A 207 sqft "1 bedroom" (observed: a real Los Angeles
 * condo building) is not comparable to a normal ~700-900 sqft 1BR, so applying
 * the ZIP's normal 1BR median rent to it manufactures an absurd cap rate — the
 * exact kind of false impression this product exists to prevent (brief §2).
 *
 * This does not try to re-derive the "right" rent (we lack the data — RentCast's
 * market endpoint has no square-footage breakdown); it only flags when the
 * basis clearly does not apply, so confidence/de-emphasis can say so honestly.
 *
 * Pure module.
 */

/**
 * Roughly the smallest plausible size (sqft) for a legitimate unit with this
 * many bedrooms. Deliberately lenient (real micro-units exist) — this is a
 * floor for "the ZIP bedroom-median clearly does not apply", not a comfort
 * standard.
 */
export function minPlausibleSquareFootage(bedrooms: number | null | undefined): number {
  const beds = bedrooms == null ? 1 : Math.max(0, bedrooms);
  if (beds <= 0) return 250;
  if (beds === 1) return 400;
  if (beds === 2) return 600;
  return 600 + (beds - 2) * 200;
}

/**
 * True when `squareFootage` is known and clearly too small for `bedrooms` for
 * a ZIP bedroom-matched rent to plausibly apply. Returns false when
 * squareFootage is unknown — we never guess a penalty from absence of data.
 */
export function isAtypicallySmall(
  squareFootage: number | null | undefined,
  bedrooms: number | null | undefined,
): boolean {
  if (squareFootage == null || squareFootage <= 0) return false;
  return squareFootage < minPlausibleSquareFootage(bedrooms);
}
