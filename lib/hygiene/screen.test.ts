import { describe, it, expect } from "vitest";
import { screenListing, screenListings, type ScreenableListing } from "./screen";

const NOW = new Date("2026-07-07T00:00:00Z");
const FRESH = new Date("2026-07-06T00:00:00Z"); // 1 day old

/** A clean, renderable listing; override per test. */
function base(overrides: Partial<ScreenableListing> = {}): ScreenableListing {
  return {
    status: "Active",
    listingType: "Standard",
    propertyType: "Single Family",
    unitCount: null,
    seniorRestricted: false,
    isActive: true,
    lastSeen: FRESH,
    missedSyncCount: 0,
    ...overrides,
  };
}

function screen(overrides: Partial<ScreenableListing> = {}) {
  return screenListing(base(overrides), NOW);
}

describe("hygiene — the clean case renders", () => {
  it("Active, fresh, single-family passes every check", () => {
    const r = screen();
    expect(r.render).toBe(true);
    expect(r.reasons).toHaveLength(0);
  });
});

describe("hygiene — status exclusions (QA §15.D)", () => {
  it.each(["Sold", "Pending", "Contingent", "Under Contract", "Off-market", "Coming Soon", "Withdrawn", "Inactive"])(
    "excludes status %s",
    (status) => {
      const r = screen({ status });
      expect(r.render).toBe(false);
      expect(r.reasons.some((x) => x.code === "status-not-active")).toBe(true);
    },
  );

  it("normalises punctuation/case (e.g. 'under_contract')", () => {
    expect(screen({ status: "under_contract" }).render).toBe(false);
    expect(screen({ status: "ACTIVE" }).render).toBe(true);
  });

  it("excludes an unknown status conservatively", () => {
    expect(screen({ status: "SomethingWeird" }).render).toBe(false);
  });
});

describe("hygiene — listing-type exclusions (distressed/non-comparable)", () => {
  it.each(["Foreclosure", "Pre-Foreclosure", "Auction", "REO", "Bank Owned", "Short Sale", "New Construction"])(
    "excludes listing type %s",
    (listingType) => {
      const r = screen({ listingType });
      expect(r.render).toBe(false);
      expect(r.reasons.some((x) => x.code === "excluded-listing-type")).toBe(true);
    },
  );
});

describe("hygiene — property-type allowlist", () => {
  it("excludes raw land specifically", () => {
    const r = screen({ propertyType: "Land" });
    expect(r.render).toBe(false);
    expect(r.reasons.some((x) => x.code === "raw-land")).toBe(true);
  });

  it.each(["Apartment", "Commercial", "Manufactured", "Mobile Home"])(
    "excludes non-included type %s",
    (propertyType) => {
      expect(screen({ propertyType }).render).toBe(false);
    },
  );

  it("excludes unknown/missing property type", () => {
    expect(screen({ propertyType: null }).render).toBe(false);
  });

  it.each(["Single Family", "Condo", "Townhome", "Townhouse", "Duplex", "Triplex", "Fourplex", "Multi-Family"])(
    "includes type %s",
    (propertyType) => {
      expect(screen({ propertyType }).render).toBe(true);
    },
  );
});

describe("hygiene — 2–4 unit multifamily cap", () => {
  it("renders a 4-unit multifamily", () => {
    expect(screen({ propertyType: "Multi-Family", unitCount: 4 }).render).toBe(true);
  });

  it("excludes a 5+ unit multifamily", () => {
    const r = screen({ propertyType: "Multi-Family", unitCount: 5 });
    expect(r.render).toBe(false);
    expect(r.reasons.some((x) => x.code === "larger-multifamily")).toBe(true);
  });

  it("uses the unit count implied by the type name (fourplex = 4, renders)", () => {
    expect(screen({ propertyType: "Fourplex" }).render).toBe(true);
  });

  it("renders a multifamily with unknown unit count (can't prove >4)", () => {
    expect(screen({ propertyType: "Multi-Family", unitCount: null }).render).toBe(true);
  });
});

describe("hygiene — fractional / co-ownership brokerages (Pacaso etc.)", () => {
  it("excludes a listing whose office is a fractional brokerage", () => {
    const r = screen({ listingOfficeName: "Pacaso Inc." });
    expect(r.render).toBe(false);
    expect(r.reasons.some((x) => x.code === "fractional-ownership")).toBe(true);
  });

  it("excludes on the office website host", () => {
    expect(screen({ listingOfficeWebsite: "https://www.pacaso.com/" }).render).toBe(false);
  });

  it("excludes on the agent email domain", () => {
    expect(screen({ listingAgentEmail: "mls@pacaso.com" }).render).toBe(false);
  });

  it("excludes on the AGENT name / office email too (all six contact fields screened)", () => {
    expect(screen({ listingAgentName: "Pacaso Listing Agent" }).render).toBe(false);
    expect(screen({ listingOfficeEmail: "hello@pacaso.com" }).render).toBe(false);
    expect(screen({ listingAgentWebsite: "https://pacaso.com/x" }).render).toBe(false);
  });

  it("excludes another known fractional brand (Kocomo)", () => {
    expect(screen({ listingOfficeName: "Kocomo Homes" }).render).toBe(false);
  });

  it("does not exclude a normal brokerage", () => {
    expect(
      screen({ listingOfficeName: "Coldwell Banker Realty", listingAgentEmail: "agent@coldwellbanker.com" }).render,
    ).toBe(true);
  });

  it("does not false-positive on an ordinary name that merely contains a common substring", () => {
    // 'ember' (a fractional brand we deliberately DON'T list) is a substring of
    // 'September' — a listing office we must not wrongly exclude.
    expect(screen({ listingOfficeName: "September Realty Group" }).render).toBe(true);
  });

  it("ignores absent office/agent fields", () => {
    expect(
      screen({
        listingOfficeName: null,
        listingOfficeWebsite: null,
        listingOfficeEmail: null,
        listingAgentName: null,
        listingAgentWebsite: null,
        listingAgentEmail: null,
      }).render,
    ).toBe(true);
  });
});

describe("hygiene — senior (55+) restriction", () => {
  it("excludes an age-restricted listing", () => {
    const r = screen({ seniorRestricted: true });
    expect(r.render).toBe(false);
    expect(r.reasons.some((x) => x.code === "senior-restricted")).toBe(true);
  });
});

describe("hygiene — freshness (never show stale; QA §15.D)", () => {
  it("excludes an inactive-flagged listing", () => {
    expect(screen({ isActive: false }).reasons.some((x) => x.code === "inactive-flag")).toBe(true);
  });

  it("excludes a listing absent from the last N syncs", () => {
    const r = screen({ missedSyncCount: 2 }); // default limit = 2
    expect(r.render).toBe(false);
    expect(r.reasons.some((x) => x.code === "missed-syncs")).toBe(true);
  });

  it("excludes a listing whose lastSeen is stale", () => {
    const old = new Date("2026-06-01T00:00:00Z"); // >14 days before NOW
    const r = screen({ lastSeen: old });
    expect(r.render).toBe(false);
    expect(r.reasons.some((x) => x.code === "stale-last-seen")).toBe(true);
  });

  it("renders a listing seen within the freshness window", () => {
    expect(screen({ lastSeen: FRESH }).render).toBe(true);
  });
});

describe("hygiene — reasons accumulate", () => {
  it("reports every failing check, not just the first", () => {
    const r = screen({ status: "Sold", propertyType: "Land", seniorRestricted: true });
    const codes = r.reasons.map((x) => x.code);
    expect(codes).toContain("status-not-active");
    expect(codes).toContain("raw-land");
    expect(codes).toContain("senior-restricted");
  });
});

describe("hygiene — batch partition guarantees only clean pins render", () => {
  it("every rendered listing is Active and fresh; excluded carry reasons", () => {
    const batch: ScreenableListing[] = [
      base(), // clean -> rendered
      base({ status: "Sold" }),
      base({ listingType: "Foreclosure" }),
      base({ propertyType: "Land" }),
      base({ isActive: false }),
      base({ propertyType: "Condo" }), // clean -> rendered
    ];
    const { rendered, excluded } = screenListings(batch, NOW);

    expect(rendered).toHaveLength(2);
    for (const r of rendered) {
      expect(r.status.toLowerCase()).toBe("active");
      expect(r.isActive).not.toBe(false);
    }
    expect(excluded).toHaveLength(4);
    for (const e of excluded) expect(e.reasons.length).toBeGreaterThan(0);
  });
});
