import { describe, it, expect } from "vitest";
import { parsePinsParams, parseAssumptions } from "./pinsParams";

const sp = (obj: Record<string, string>) => new URLSearchParams(obj);

describe("parsePinsParams — boundary validation (brief §9)", () => {
  const validBbox = "-117.45,34.05,-117.15,34.25";

  it("parses a valid request and defaults the mode to return_only", () => {
    const r = parsePinsParams(sp({ bbox: validBbox, target: "100", allCash: "true" }));
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.mode).toBe("return_only");
      expect(r.data.target).toBe(100);
      expect(r.data.financing.allCash).toBe(true);
      expect(r.data.bbox).toEqual({ minLng: -117.45, minLat: 34.05, maxLng: -117.15, maxLat: 34.25 });
    }
  });

  it("switches to budget_return when a budget is present", () => {
    const r = parsePinsParams(sp({ bbox: validBbox, target: "100", budget: "400000" }));
    expect(r.success && r.data.mode).toBe("budget_return");
  });

  it("rejects a malformed bbox", () => {
    expect(parsePinsParams(sp({ bbox: "1,2,3", target: "100" })).success).toBe(false);
  });

  it("rejects a bbox with min >= max", () => {
    expect(parsePinsParams(sp({ bbox: "-117,34,-118,35", target: "100" })).success).toBe(false);
  });

  it("rejects out-of-range coordinates", () => {
    expect(parsePinsParams(sp({ bbox: "-200,34,-117,35", target: "100" })).success).toBe(false);
  });

  it("requires a positive target", () => {
    expect(parsePinsParams(sp({ bbox: validBbox, target: "0" })).success).toBe(false);
    expect(parsePinsParams(sp({ bbox: validBbox })).success).toBe(false);
  });

  it("applies conservative defaults for omitted assumptions", () => {
    const r = parsePinsParams(sp({ bbox: validBbox, target: "100" }));
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.financing.allCash).toBe(false);
      expect(r.data.financing.downPaymentPct).toBe(0.2);
      expect(r.data.financing.annualRatePct).toBe(7);
      expect(r.data.expenseAssumptions.vacancyPct).toBe(0.06);
    }
  });

  it("clamps limit within [1,5000]", () => {
    expect(parsePinsParams(sp({ bbox: validBbox, target: "100", limit: "99999" })).success).toBe(false);
  });
});

describe("parseAssumptions — detail route", () => {
  it("defaults to conservative financed", () => {
    const a = parseAssumptions(sp({}));
    expect(a.financing.allCash).toBe(false);
    expect(a.financing.annualRatePct).toBe(7);
    expect(a.expenseAssumptions.managementPct).toBe(0.08);
  });

  it("honours an all-cash override", () => {
    expect(parseAssumptions(sp({ allCash: "true" })).financing.allCash).toBe(true);
  });
});
