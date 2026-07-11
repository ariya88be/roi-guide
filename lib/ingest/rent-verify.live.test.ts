/**
 * One-shot LIVE rent verification for shortlisted candidates: pulls RentCast's
 * property-level rent AVM (with comps) for each address and recomputes the
 * all-cash cash flow with the verified rent, side by side with the stored
 * ZIP-median figure. Gated so it never runs in the normal suite (spends real
 * provider quota):
 *   set -a && . ./.env.local && set +a && RUN_RENT_VERIFY=1 \
 *     npx vitest run lib/ingest/rent-verify.live.test.ts --reporter=verbose
 */
import { describe, it, expect } from "vitest";
import { createRentCastClient } from "@/lib/providers/rentcast";
import { median } from "@/lib/roi/statistics";
import { computeListingRoi } from "./compute";

const enabled = process.env.RUN_RENT_VERIFY === "1" && !!process.env.RENTCAST_API_KEY;
const live = enabled ? describe : describe.skip;

/** The current shortlist (stored ZIP-median numbers said these clear the owner's bar). */
const CANDIDATES = [
  {
    address: "28947 E Thousand Oaks Blvd, Agoura Hills, CA 91301",
    propertyType: "Condo", bedrooms: 1, bathrooms: 1, squareFootage: 501,
    price: 299999, hoa: 593, storedRent: 5200, storedCashFlow: 1466.28,
  },
  {
    address: "501 N Palisades Dr, Unit 103, Pacific Palisades, CA 90272",
    propertyType: "Condo", bedrooms: 1, bathrooms: 1, squareFootage: 593,
    price: 289804, hoa: 554, storedRent: 4975, storedCashFlow: 1397.64,
  },
];

live("LIVE rent verification (real RentCast AVM)", () => {
  it(
    "verifies each candidate's rent via property-level AVM + comps",
    async () => {
      const client = createRentCastClient();
      for (const c of CANDIDATES) {
        try {
          const est = await client.getRentEstimate({
            address: c.address,
            propertyType: c.propertyType,
            bedrooms: c.bedrooms,
            bathrooms: c.bathrooms,
            squareFootage: c.squareFootage,
          });
          const compRents = (est.comparables ?? []).map((k) => k.price);
          const compMedian = compRents.length > 0 ? median(compRents) : null;
          // Conservative verified basis: the LOWER of the AVM point estimate
          // and the median of its comps (err low, per product principle #2).
          const verifiedRent = compMedian == null ? est.rent : Math.min(est.rent, compMedian);
          const roi = computeListingRoi({
            price: c.price,
            monthlyRent: verifiedRent,
            monthlyHoa: c.hoa,
            sampleSize: compRents.length,
            allCash: true,
            squareFootage: c.squareFootage,
            bedrooms: c.bedrooms,
            propertyType: c.propertyType,
            bedroomMatched: true,
            zipMedianRentPerSqft: null,
          });
          console.log(
            "VERIFY:",
            JSON.stringify({
              address: c.address,
              price: c.price,
              storedRent: c.storedRent,
              storedCashFlow: c.storedCashFlow,
              avmRent: est.rent,
              avmRange: [est.rentRangeLow ?? null, est.rentRangeHigh ?? null],
              compCount: compRents.length,
              compMedian,
              compRents: compRents.slice(0, 10),
              verifiedRent,
              verifiedCashFlow: Math.round(roi.monthlyCashFlow * 100) / 100,
            }),
          );
        } catch (err) {
          console.log("VERIFY-ERROR:", c.address, String(err));
        }
      }
      expect(true).toBe(true);
    },
    120_000,
  );
});
