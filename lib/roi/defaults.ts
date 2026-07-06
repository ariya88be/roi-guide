/**
 * Conservative default assumptions.
 *
 * Brief section 2.2: "Default conservative, never optimistic." Every default
 * here is chosen so that, when a real figure is missing, the resulting cash
 * flow errs LOW rather than high. These are the exact line items naive tools
 * omit (vacancy, management, maintenance/CapEx) — omitting them is what
 * manufactures false profit.
 *
 * All rates are annual unless the name says monthly. Percentages are fractions
 * (0.06 === 6%). Every value is overridable per-request; the UI's
 * "reset to conservative defaults" control restores exactly this object.
 */

export interface RoiDefaults {
  /** Vacancy reserve as a fraction of gross rent. */
  vacancyPct: number;
  /** Property management as a fraction of gross rent (conservative: assume paid). */
  managementPct: number;
  /** Maintenance + CapEx reserve as a fraction of gross rent. */
  maintenancePct: number;
  /** Down payment as a fraction of price. */
  downPaymentPct: number;
  /** Mortgage APR (percent, e.g. 7). A market input; refresh periodically. */
  annualRatePct: number;
  /** Loan term in months. */
  termMonths: number;
  /**
   * Effective annual property-tax rate as a fraction of price, used only when a
   * record-level tax figure is unavailable. Greater-LA effective rates cluster
   * around 1.1–1.25%; we take the high end to stay conservative.
   */
  propertyTaxAnnualRate: number;
  /**
   * Annual insurance estimate as a fraction of price, used only when a
   * record-level premium is unavailable. Flagged as estimated when used.
   */
  insuranceAnnualRate: number;
  /**
   * Fraction of price attributable to the building (vs. land) for depreciation
   * in the ROUGH after-tax estimate. Land is not depreciable.
   */
  buildingFraction: number;
  /** Marginal tax rate (fraction) for the rough after-tax estimate. */
  marginalTaxRate: number;
  /**
   * Minimum comp count below which rent confidence is forced to "Low" and the
   * pin is de-emphasised (brief section 6.D / QA 15.B).
   */
  minCompsForConfidence: number;
}

export const CONSERVATIVE_DEFAULTS: Readonly<RoiDefaults> = Object.freeze({
  vacancyPct: 0.06,
  managementPct: 0.08,
  maintenancePct: 0.08,
  downPaymentPct: 0.2,
  annualRatePct: 7,
  termMonths: 360,
  propertyTaxAnnualRate: 0.0125,
  insuranceAnnualRate: 0.0035,
  buildingFraction: 0.8,
  marginalTaxRate: 0.24,
  minCompsForConfidence: 3,
});
