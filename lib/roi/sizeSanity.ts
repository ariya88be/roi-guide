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

/**
 * How many times the ZIP's median rent-per-square-foot the applied rent basis
 * may imply before we call it implausible. A tiny unit handed a big-unit ZIP
 * median rent (observed: a 440 sqft studio assigned the ZIP's $6,000 overall
 * median → ~$13.6/sqft vs a ~$3.5/sqft ZIP norm) manufactures a fake yield.
 * Generous headroom (real premium micro-units exist) — this is a "clearly
 * wrong", not "above average", threshold.
 */
export const MAX_PLAUSIBLE_RENT_PSF_RATIO = 2.5;

/**
 * True when the applied monthly rent implies a rent-per-sqft far above the
 * ZIP's own median rent-per-sqft — i.e. the ZIP bedroom/overall median clearly
 * doesn't fit this unit and the resulting cash flow is not to be trusted.
 * Returns false whenever any input is missing (never penalise absent data).
 */
export function isImplausibleRentForSize(
  monthlyRent: number | null | undefined,
  squareFootage: number | null | undefined,
  zipMedianRentPerSqft: number | null | undefined,
): boolean {
  if (monthlyRent == null || monthlyRent <= 0) return false;
  if (squareFootage == null || squareFootage <= 0) return false;
  if (zipMedianRentPerSqft == null || zipMedianRentPerSqft <= 0) return false;
  const impliedPsf = monthlyRent / squareFootage;
  return impliedPsf > MAX_PLAUSIBLE_RENT_PSF_RATIO * zipMedianRentPerSqft;
}
