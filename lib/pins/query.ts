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
import {
  classifyBand,
  interpolatePalette,
  DEFAULT_GRADIENT_CONFIG,
  type GradientConfig,
} from "@/lib/roi/color";
import { scoreDeals } from "@/lib/roi/deal";
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

  // Pass 1: recompute cash flow for EVERY listing in view, and its cap rate
  // (financing-independent return on capital). Deal quality is scored against
  // the whole local market, so we keep all rows here, not just target-clearers.
  interface Scored {
    r: Row;
    price: number;
    monthlyRent: number;
    cashFlow: number;
    capRate: number;
    hoaMissing: boolean;
  }
  const scored: Scored[] = [];
  for (const r of rows) {
    const price = n(r.price);
    if (!(price > 0)) continue;
    const monthlyRent = n(r.median_rent);
    const cf = computeMonthlyCashFlow({
      price,
      monthlyRent,
      financing: { price, ...q.financing },
      monthlyHoa: r.hoa_fee == null ? null : n(r.hoa_fee),
      assumptions: q.expenseAssumptions,
    });
    // NOI = cash flow + the mortgage we subtracted (financing-independent).
    const noiMonthly = cf.monthlyCashFlow + cf.expenses.mortgage.monthly;
    const capRate = (noiMonthly * 12) / price;
    scored.push({ r, price, monthlyRent, cashFlow: cf.monthlyCashFlow, capRate, hoaMissing: cf.flags.hoaMissing });
  }

  // Local spatial-outlier deal scoring across the whole in-view market.
  const deals = scoreDeals(
    scored.map((s) => ({ id: s.r.id as string, lat: n(s.r.lat), lng: n(s.r.lng), price: s.price, capRate: s.capRate })),
  );

  // Pass 2: build features for target-clearers, coloured by DEAL QUALITY.
  const features: PinFeature[] = [];
  for (const s of scored) {
    if (s.cashFlow < q.target) continue; // target filter (Feature A/B)
    const deal = deals.get(s.r.id as string)!;
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [n(s.r.lng), n(s.r.lat)] },
      properties: {
        id: s.r.id,
        address: (s.r.formatted_address as string) ?? (s.r.city as string) ?? "Unknown",
        propertyType: s.r.property_type,
        bedrooms: s.r.bedrooms,
        bathrooms: s.r.bathrooms,
        price: s.price,
        cashFlow: Math.round(s.cashFlow),
        medianRent: Math.round(s.monthlyRent),
        capRatePct: Math.round(s.capRate * 1000) / 10,
        localCapRatePct: Math.round(deal.localMedianCapRate * 1000) / 10,
        relAdvantagePct: Math.round(deal.relAdvantage * 100),
        dealScore: Math.round(deal.dealScore * 100) / 100,
        cluster: deal.cluster,
        belowMarket: deal.belowMarket,
        color: interpolatePalette(deal.dealScore, gradient),
        heatWeight: Math.max(0.08, deal.dealScore),
        band: classifyBand(s.cashFlow, q.target),
        confidence: s.r.confidence_level,
        confidenceScore: s.r.confidence_score,
        deEmphasize: s.r.de_emphasize,
        hoaMissing: s.hoaMissing,
      },
    });
  }

  // Best DEALS first (not just biggest cash flow).
  features.sort((a, b) => (b.properties.dealScore as number) - (a.properties.dealScore as number));
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
  const pct1 = (frac: number) => Math.round(frac * 1000) / 10;

  // Investor metrics from data we already have.
  const cashInvested = opts.financing.allCash ? price : price * opts.financing.downPaymentPct;
  const e = cf.expenses;
  // NOI excludes financing (mortgage P&I).
  const monthlyNOI =
    monthlyRent -
    (e.vacancy.monthly + e.management.monthly + e.maintenance.monthly + e.propertyTax.monthly + e.insurance.monthly + e.hoa.monthly);
  const investment = {
    cashInvested: money(cashInvested),
    cashOnCashPct: cashInvested > 0 ? pct1((cf.monthlyCashFlow * 12) / cashInvested) : null,
    capRatePct: price > 0 ? pct1((monthlyNOI * 12) / price) : null,
    rentToPricePct: price > 0 ? pct1((monthlyRent * 12) / price) : null,
  };

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
    investment,
    confidence: {
      level: r.confidence_level,
      score: r.confidence_score,
      deEmphasize: r.de_emphasize,
      note: "Rent is the ZIP bedroom-matched median (Phase 1), not property-level comps yet — so confidence caps at Medium.",
    },
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
