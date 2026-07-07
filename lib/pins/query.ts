/**
 * Viewport pin + property-detail queries — SERVER-SIDE ONLY.
 *
 * `queryPins` runs a PostGIS bounding-box query (GiST-indexed) for active
 * listings, then RECOMPUTES each property's monthly cash flow from the caller's
 * assumptions (financing sliders + reserves) with the pure ROI engine, filters
 * by the user's target, and colours each pin with the SAME gradient function the
 * whole app uses (lib/roi/color). Recomputing per request is what makes the
 * sliders (and the all-cash toggle) work live.
 *
 * `queryPropertyDetail` returns the itemised expense breakdown under the same
 * assumptions — "never a bare number" (brief §2.1).
 */
import { sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { colorForCashFlow, DEFAULT_GRADIENT_CONFIG, type GradientConfig } from "@/lib/roi/color";
import { computeMonthlyCashFlow } from "@/lib/roi/cashflow";
import { roughAfterTaxMonthlyCashFlow } from "@/lib/roi/afterTax";
import { CONSERVATIVE_DEFAULTS } from "@/lib/roi/defaults";

export interface BBox {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
}

export interface FinancingParams {
  allCash: boolean;
  downPaymentPct: number;
  annualRatePct: number;
  termMonths: number;
}
export interface ExpenseAssumptions {
  vacancyPct: number;
  managementPct: number;
  maintenancePct: number;
}

export interface PinsQuery {
  bbox: BBox;
  target: number;
  budget?: number | null;
  mode: "budget_return" | "return_only";
  financing: FinancingParams;
  expenseAssumptions: ExpenseAssumptions;
  gradient?: GradientConfig;
  limit?: number;
}

export interface PinFeature {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: Record<string, unknown>;
}
export interface PinCollection {
  type: "FeatureCollection";
  features: PinFeature[];
  /** How many active listings the viewport held before the target filter. */
  scanned: number;
}

type Row = Record<string, unknown>;
const n = (v: unknown): number => Number(v);
/** Safety cap on rows pulled before the in-app target filter. */
const SCAN_CAP = 5000;

export async function queryPins(q: PinsQuery): Promise<PinCollection> {
  const db = getDb();
  const budgetCond =
    q.mode === "budget_return" && q.budget != null ? sql`and l.price <= ${q.budget}` : sql``;

  const rows = (await db.execute(sql`
    select p.id, p.formatted_address, p.city, p.property_type,
           p.bedrooms::float as bedrooms, p.bathrooms::float as bathrooms,
           l.price::float as price, l.hoa_fee::float as hoa_fee,
           cr.median_rent::float as median_rent,
           cr.confidence_level, cr.confidence_score, cr.de_emphasize, cr.hoa_missing,
           ST_X(p.location) as lng, ST_Y(p.location) as lat
    from computed_roi cr
    join listings l on cr.listing_id = l.id
    join properties p on l.property_id = p.id
    where l.is_active = true
      and p.location && ST_MakeEnvelope(${q.bbox.minLng}, ${q.bbox.minLat}, ${q.bbox.maxLng}, ${q.bbox.maxLat}, 4326)
      ${budgetCond}
    limit ${SCAN_CAP}
  `)) as unknown as Row[];

  const gradient = q.gradient ?? DEFAULT_GRADIENT_CONFIG;
  const features: PinFeature[] = [];

  for (const r of rows) {
    const price = n(r.price);
    const monthlyRent = n(r.median_rent);
    const cf = computeMonthlyCashFlow({
      price,
      monthlyRent,
      financing: { price, ...q.financing },
      monthlyHoa: r.hoa_fee == null ? null : n(r.hoa_fee),
      assumptions: q.expenseAssumptions,
    });
    if (cf.monthlyCashFlow < q.target) continue; // target filter (Feature A/B)

    const color = colorForCashFlow(cf.monthlyCashFlow, q.target, gradient);
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [n(r.lng), n(r.lat)] },
      properties: {
        id: r.id,
        address: (r.formatted_address as string) ?? (r.city as string) ?? "Unknown",
        propertyType: r.property_type,
        bedrooms: r.bedrooms,
        bathrooms: r.bathrooms,
        price,
        cashFlow: Math.round(cf.monthlyCashFlow),
        medianRent: Math.round(monthlyRent),
        color: color.hex,
        band: color.band,
        confidence: r.confidence_level,
        confidenceScore: r.confidence_score,
        deEmphasize: r.de_emphasize,
        hoaMissing: cf.flags.hoaMissing,
      },
    });
  }

  features.sort((a, b) => (b.properties.cashFlow as number) - (a.properties.cashFlow as number));
  return {
    type: "FeatureCollection",
    features: features.slice(0, q.limit ?? 2000),
    scanned: rows.length,
  };
}

export interface DetailOptions {
  financing: FinancingParams;
  expenseAssumptions: ExpenseAssumptions;
}

/** Full breakdown for one property's detail card (recomputes the itemised math). */
export async function queryPropertyDetail(id: string, opts: DetailOptions) {
  const db = getDb();
  const result = (await db.execute(sql`
    select p.id, p.formatted_address, p.city, p.state, p.zip_code, p.property_type,
           p.bedrooms::float as bedrooms, p.bathrooms::float as bathrooms, p.square_footage,
           l.price::float as price, l.hoa_fee::float as hoa_fee, l.status, l.last_seen, l.listed_date,
           cr.median_rent::float as median_rent, cr.avm_rent::float as avm_rent,
           cr.confidence_level, cr.confidence_score, cr.de_emphasize, cr.assumptions_hash, cr.computed_at
    from properties p
    join listings l on l.property_id = p.id
    join computed_roi cr on cr.listing_id = l.id
    where p.id = ${id}
    limit 1
  `)) as unknown as Row[];

  if (result.length === 0) return null;
  const r = result[0];

  const price = n(r.price);
  const monthlyRent = n(r.median_rent);
  const monthlyHoa = r.hoa_fee == null ? null : n(r.hoa_fee);

  const cf = computeMonthlyCashFlow({
    price,
    monthlyRent,
    financing: { price, ...opts.financing },
    monthlyHoa,
    assumptions: opts.expenseAssumptions,
  });
  const afterTax = roughAfterTaxMonthlyCashFlow({ price, preTaxMonthlyCashFlow: cf.monthlyCashFlow });
  const money = (v: number) => Math.round(v);

  return {
    property: {
      id: r.id,
      address: r.formatted_address ?? r.city ?? "Unknown",
      city: r.city,
      state: r.state,
      zipCode: r.zip_code,
      propertyType: r.property_type,
      bedrooms: r.bedrooms,
      bathrooms: r.bathrooms,
      squareFootage: r.square_footage,
    },
    listing: {
      price,
      hoaFee: monthlyHoa,
      status: r.status,
      lastVerified: r.last_seen,
      listedDate: r.listed_date,
    },
    rent: {
      medianRent: money(monthlyRent),
      avmRent: r.avm_rent == null ? null : money(n(r.avm_rent)),
      basis: "ZIP bedroom-matched median (Phase 1)",
    },
    assumptions: { ...opts.financing, ...opts.expenseAssumptions, hash: r.assumptions_hash },
    breakdown: {
      grossRent: money(monthlyRent),
      vacancy: money(cf.expenses.vacancy.monthly),
      management: money(cf.expenses.management.monthly),
      maintenance: money(cf.expenses.maintenance.monthly),
      mortgage: money(cf.expenses.mortgage.monthly),
      propertyTax: money(cf.expenses.propertyTax.monthly),
      insurance: money(cf.expenses.insurance.monthly),
      hoa: money(cf.expenses.hoa.monthly),
      monthlyCashFlow: money(cf.monthlyCashFlow),
    },
    flags: {
      hoaMissing: cf.flags.hoaMissing,
      taxEstimated: cf.flags.propertyTaxEstimated,
      insuranceEstimated: cf.flags.insuranceEstimated,
    },
    afterTax: { roughMonthly: money(afterTax.roughAfterTaxMonthlyCashFlow), disclaimer: afterTax.disclaimer },
    confidence: { level: r.confidence_level, score: r.confidence_score, deEmphasize: r.de_emphasize },
    computedAt: r.computed_at,
  };
}

/** Conservative default assumptions, for callers that don't override. */
export const DEFAULT_FINANCING: FinancingParams = {
  allCash: false,
  downPaymentPct: CONSERVATIVE_DEFAULTS.downPaymentPct,
  annualRatePct: CONSERVATIVE_DEFAULTS.annualRatePct,
  termMonths: CONSERVATIVE_DEFAULTS.termMonths,
};
export const DEFAULT_EXPENSE_ASSUMPTIONS: ExpenseAssumptions = {
  vacancyPct: CONSERVATIVE_DEFAULTS.vacancyPct,
  managementPct: CONSERVATIVE_DEFAULTS.managementPct,
  maintenancePct: CONSERVATIVE_DEFAULTS.maintenancePct,
};
