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
    address: "7790 Sierra Ave, Fontana, CA 92336",
    propertyType: "Single Family", bedrooms: 2, bathrooms: 1, squareFootage: 877,
    price: 484999, hoa: null, storedRent: 3500, storedCashFlow: -498.03,
  },
  {
    address: "16268 Barbee St, Fontana, CA 92336",
    propertyType: "Single Family", bedrooms: 2, bathrooms: 1, squareFootage: 848,
    price: 499000, hoa: null, storedRent: 3500, storedCashFlow: -591.22,
  },
  {
    address: "1425 Allium Ct, Beaumont, CA 92223",
    propertyType: "Single Family", bedrooms: 4, bathrooms: 3, squareFootage: 1725,
    price: 450000, hoa: 151, storedRent: 3500, storedCashFlow: -416.09,
  },
  {
    address: "452 Cherry Vista Dr, Perris, CA 92571",
    propertyType: "Single Family", bedrooms: 4, bathrooms: 2.5, squareFootage: 1407,
    price: 499900, hoa: null, storedRent: 3149, storedCashFlow: -870.99,
  },
  {
    address: "12362 Champlain St, Moreno Valley, CA 92557",
    propertyType: "Single Family", bedrooms: 4, bathrooms: 2.5, squareFootage: 1633,
    price: 499900, hoa: null, storedRent: 3100, storedCashFlow: -909.21,
  },
  {
    address: "1324 Brentwood Cir, Unit B, Corona, CA 92882",
    propertyType: "Single Family", bedrooms: 2, bathrooms: 2, squareFootage: 1095,
    price: 399900, hoa: 554, storedRent: 3589, storedCashFlow: -416.22,
  },
  {
    address: "13894 Meadow Ln, Lytle Creek, CA 92358",
    propertyType: "Single Family", bedrooms: 3, bathrooms: 2, squareFootage: 1326,
    price: 484000, hoa: null, storedRent: 3000, storedCashFlow: -881.38,
  },
  {
    address: "1341 Palisades St, Perris, CA 92570",
    propertyType: "Single Family", bedrooms: 4, bathrooms: 2, squareFootage: 1230,
    price: 499000, hoa: null, storedRent: 3000, storedCashFlow: -981.22,
  },
  {
    address: "3688 Rossmuir St, Riverside, CA 92504",
    propertyType: "Single Family", bedrooms: 3, bathrooms: 1.5, squareFootage: 1760,
    price: 480000, hoa: null, storedRent: 2950, storedCashFlow: -893.76,
  },
  {
    address: "3895 Twining St, Jurupa Valley, CA 92509",
    propertyType: "Single Family", bedrooms: 3, bathrooms: 1, squareFootage: 810,
    price: 494999, hoa: null, storedRent: 2950, storedCashFlow: -993.59,
  },
  {
    address: "24412 Broad Ave, Wilmington, CA 90744",
    propertyType: "Single Family", bedrooms: 2, bathrooms: 1, squareFootage: 835,
    price: 499000, hoa: null, storedRent: 2900, storedCashFlow: -1059.22,
  },
  {
    address: "1008 W 14th St, San Bernardino, CA 92411",
    propertyType: "Single Family", bedrooms: 3, bathrooms: 1, squareFootage: 998,
    price: 395000, hoa: null, storedRent: 2700, storedCashFlow: -523.02,
  },
  {
    address: "12426 2nd St, Yucaipa, CA 92399",
    propertyType: "Single Family", bedrooms: 3, bathrooms: 2, squareFootage: 1189,
    price: 485000, hoa: null, storedRent: 2800, storedCashFlow: -1044.04,
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
