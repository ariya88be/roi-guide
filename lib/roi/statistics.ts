/**
 * Statistical primitives for the ROI engine.
 *
 * Design rule (section 2.5 of the brief): "One outlier must never move an
 * area's estimate." We therefore build on the MEDIAN, never the mean, and we
 * expose spread measures (sample standard deviation, IQR, and their
 * coefficients relative to the median) so confidence scoring can penalise wide,
 * skewed comp sets rather than silently averaging them away.
 *
 * All functions are pure and side-effect free.
 */

/** Thrown when a statistic is undefined for the given input (e.g. empty set). */
export class EmptyDatasetError extends Error {
  constructor(fn: string) {
    super(`${fn}: cannot compute a statistic from an empty dataset`);
    this.name = "EmptyDatasetError";
  }
}

/** Return a sorted copy (ascending). Does not mutate the input. */
function sortedAsc(values: readonly number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

/**
 * Arithmetic mean. Provided ONLY for tests and comparison displays — it must
 * never be the basis for a rent estimate. Use {@link median} for that.
 */
export function mean(values: readonly number[]): number {
  if (values.length === 0) throw new EmptyDatasetError("mean");
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * Median. For an even-length set, returns the average of the two central
 * values. This is the canonical rent basis for the whole product.
 *
 * Example the brief calls out explicitly: median([1000,1000,1000,4000]) === 1000
 * (the single $4,000 outlier does not drag the estimate up to the mean of 1750).
 */
export function median(values: readonly number[]): number {
  if (values.length === 0) throw new EmptyDatasetError("median");
  const s = sortedAsc(values);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

/**
 * Value at a percentile (0..1) using linear interpolation between closest
 * ranks — the "linear" / R-7 method, matching most spreadsheet software.
 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) throw new EmptyDatasetError("percentile");
  if (p < 0 || p > 1) throw new RangeError(`percentile: p must be in [0,1], got ${p}`);
  const s = sortedAsc(values);
  if (s.length === 1) return s[0];
  const rank = p * (s.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return s[lo];
  const frac = rank - lo;
  return s[lo] + (s[hi] - s[lo]) * frac;
}

/** Interquartile range: P75 − P25. A robust (outlier-resistant) spread measure. */
export function interquartileRange(values: readonly number[]): number {
  if (values.length === 0) throw new EmptyDatasetError("interquartileRange");
  return percentile(values, 0.75) - percentile(values, 0.25);
}

/**
 * Sample standard deviation (Bessel's correction, n−1 denominator).
 * Returns 0 for a single-element set (no spread is defined, treat as tight).
 */
export function sampleStdDev(values: readonly number[]): number {
  if (values.length === 0) throw new EmptyDatasetError("sampleStdDev");
  if (values.length === 1) return 0;
  const m = mean(values);
  const sumSq = values.reduce((acc, v) => acc + (v - m) ** 2, 0);
  return Math.sqrt(sumSq / (values.length - 1));
}

/**
 * Coefficient of variation relative to the MEDIAN: stdev / median.
 * Lower = tighter cluster = more trustworthy. We divide by the median (not the
 * mean) deliberately, so a skewed set is measured against its robust centre.
 * Returns 0 when the median is 0 to avoid division by zero.
 */
export function coefficientOfVariation(values: readonly number[]): number {
  const med = median(values);
  if (med === 0) return 0;
  return sampleStdDev(values) / med;
}

/** IQR relative to the median: a fully outlier-resistant spread ratio. */
export function robustSpreadRatio(values: readonly number[]): number {
  const med = median(values);
  if (med === 0) return 0;
  return interquartileRange(values) / med;
}
