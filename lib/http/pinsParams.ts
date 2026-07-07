/**
 * Zod validation for the /api/pins query string (brief §9: validate every input
 * at the boundary). Parses and bounds-checks the viewport, target, budget,
 * palette, AND the assumption sliders (financing + reserves) before any of it
 * reaches a SQL query or the ROI engine.
 */
import { z } from "zod";
import type { PaletteName, PaletteDirection } from "@/lib/roi/color";
import { CONSERVATIVE_DEFAULTS } from "@/lib/roi/defaults";

const D = CONSERVATIVE_DEFAULTS;
const pct = z.coerce.number().min(0).max(1);

export const PinsParamsSchema = z
  .object({
    bbox: z.string().transform((s, ctx) => {
      const parts = s.split(",").map((p) => Number(p.trim()));
      if (parts.length !== 4 || parts.some((v) => !Number.isFinite(v))) {
        ctx.addIssue({ code: "custom", message: "bbox must be 'minLng,minLat,maxLng,maxLat'" });
        return z.NEVER;
      }
      const [minLng, minLat, maxLng, maxLat] = parts;
      if (minLng >= maxLng || minLat >= maxLat) {
        ctx.addIssue({ code: "custom", message: "bbox min must be < max" });
        return z.NEVER;
      }
      if (minLng < -180 || maxLng > 180 || minLat < -90 || maxLat > 90) {
        ctx.addIssue({ code: "custom", message: "bbox out of range" });
        return z.NEVER;
      }
      return { minLng, minLat, maxLng, maxLat };
    }),
    target: z.coerce.number().finite().positive(),
    budget: z.coerce.number().finite().positive().optional(),
    mode: z.enum(["budget_return", "return_only"]).optional(),
    palette: z.enum(["rdylgn", "viridis"]).default("rdylgn"),
    direction: z.enum(["higher-is-better", "higher-is-worse"]).default("higher-is-better"),
    limit: z.coerce.number().int().min(1).max(5000).default(2000),
    // Assumption sliders (all optional; default to conservative):
    allCash: z
      .enum(["true", "false"])
      .transform((v) => v === "true")
      .default(false),
    downPaymentPct: pct.default(D.downPaymentPct),
    annualRatePct: z.coerce.number().min(0).max(30).default(D.annualRatePct),
    termMonths: z.coerce.number().int().min(1).max(600).default(D.termMonths),
    vacancyPct: pct.default(D.vacancyPct),
    managementPct: pct.default(D.managementPct),
    maintenancePct: pct.default(D.maintenancePct),
  })
  .transform((v) => ({
    bbox: v.bbox,
    target: v.target,
    budget: v.budget ?? null,
    mode: v.mode ?? (v.budget != null ? ("budget_return" as const) : ("return_only" as const)),
    limit: v.limit,
    gradient: {
      palette: v.palette as PaletteName,
      direction: v.direction as PaletteDirection,
      belowTarget: "grey" as const,
    },
    financing: {
      allCash: v.allCash,
      downPaymentPct: v.downPaymentPct,
      annualRatePct: v.annualRatePct,
      termMonths: v.termMonths,
    },
    expenseAssumptions: {
      vacancyPct: v.vacancyPct,
      managementPct: v.managementPct,
      maintenancePct: v.maintenancePct,
    },
  }));

export type PinsParams = z.infer<typeof PinsParamsSchema>;

const keys = [
  "bbox",
  "target",
  "budget",
  "mode",
  "palette",
  "direction",
  "limit",
  "allCash",
  "downPaymentPct",
  "annualRatePct",
  "termMonths",
  "vacancyPct",
  "managementPct",
  "maintenancePct",
] as const;

/** Parse from URLSearchParams; returns {success, data|error}. */
export function parsePinsParams(sp: URLSearchParams) {
  const raw: Record<string, string> = {};
  for (const k of keys) {
    const val = sp.get(k);
    if (val != null) raw[k] = val;
  }
  return PinsParamsSchema.safeParse(raw);
}

/** Assumption-only schema (financing + reserves), shared by the detail route. */
export const AssumptionsSchema = z
  .object({
    allCash: z
      .enum(["true", "false"])
      .transform((v) => v === "true")
      .default(false),
    downPaymentPct: pct.default(D.downPaymentPct),
    annualRatePct: z.coerce.number().min(0).max(30).default(D.annualRatePct),
    termMonths: z.coerce.number().int().min(1).max(600).default(D.termMonths),
    vacancyPct: pct.default(D.vacancyPct),
    managementPct: pct.default(D.managementPct),
    maintenancePct: pct.default(D.maintenancePct),
  })
  .transform((v) => ({
    financing: {
      allCash: v.allCash,
      downPaymentPct: v.downPaymentPct,
      annualRatePct: v.annualRatePct,
      termMonths: v.termMonths,
    },
    expenseAssumptions: {
      vacancyPct: v.vacancyPct,
      managementPct: v.managementPct,
      maintenancePct: v.maintenancePct,
    },
  }));

/** Parse just the assumption sliders; always succeeds (all fields default). */
export function parseAssumptions(sp: URLSearchParams) {
  const raw: Record<string, string> = {};
  for (const k of ["allCash", "downPaymentPct", "annualRatePct", "termMonths", "vacancyPct", "managementPct", "maintenancePct"] as const) {
    const val = sp.get(k);
    if (val != null) raw[k] = val;
  }
  return AssumptionsSchema.parse(raw);
}
