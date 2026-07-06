import { describe, it, expect } from "vitest";
import {
  classifyBand,
  colorForCashFlow,
  legendStops,
  DEFAULT_GRADIENT_CONFIG,
  type GradientConfig,
} from "./color";

const T = 1000;

describe("classifyBand (QA 15.C — inclusive lower bounds)", () => {
  it("is 'below' strictly under target", () => {
    expect(classifyBand(999.99, T)).toBe("below");
  });
  it("is 'meets' at exactly T and up to (not incl.) 1.5T", () => {
    expect(classifyBand(1000, T)).toBe("meets");
    expect(classifyBand(1499.99, T)).toBe("meets");
  });
  it("is 'comfortable' at exactly 1.5T and up to (not incl.) 2T", () => {
    expect(classifyBand(1500, T)).toBe("comfortable");
    expect(classifyBand(1999.99, T)).toBe("comfortable");
  });
  it("is 'strong' at exactly 2T and above", () => {
    expect(classifyBand(2000, T)).toBe("strong");
    expect(classifyBand(9999, T)).toBe("strong");
  });
});

describe("colorForCashFlow — continuous gradient anchored at T/1.5T/2T/3T", () => {
  it("hits the exact palette stop colours at the anchor ratios", () => {
    expect(colorForCashFlow(1000, T).hex).toBe("#d73027"); // ratio 1  red
    expect(colorForCashFlow(1500, T).hex).toBe("#fee08b"); // ratio 1.5 amber
    expect(colorForCashFlow(2000, T).hex).toBe("#1a9850"); // ratio 2  green
    expect(colorForCashFlow(3000, T).hex).toBe("#006837"); // ratio 3  deep green
  });

  it("interpolates continuously between anchors (not banded)", () => {
    const c = colorForCashFlow(1250, T).hex; // between red and amber
    expect(c).not.toBe("#d73027");
    expect(c).not.toBe("#fee08b");
  });

  it("clamps above 3T to the top stop", () => {
    expect(colorForCashFlow(5000, T).hex).toBe("#006837");
    expect(colorForCashFlow(5000, T).ratioClamped).toBe(3);
  });

  it("renders below-target as neutral grey by default", () => {
    const c = colorForCashFlow(500, T);
    expect(c.band).toBe("below");
    expect(c.hex).toBe("#9aa0a6");
  });

  it("can clamp below-target to the start colour instead of grey", () => {
    const cfg: GradientConfig = { ...DEFAULT_GRADIENT_CONFIG, belowTarget: "clampToStart" };
    expect(colorForCashFlow(500, T, cfg).hex).toBe("#d73027");
  });
});

describe("palette direction flip inverts the mapping (single config flag)", () => {
  it("higher-is-worse maps ratio 1 to what ratio 3 was, and vice-versa", () => {
    const flipped: GradientConfig = { ...DEFAULT_GRADIENT_CONFIG, direction: "higher-is-worse" };
    expect(colorForCashFlow(1000, T, flipped).hex).toBe("#006837"); // was deep green at top
    expect(colorForCashFlow(3000, T, flipped).hex).toBe("#d73027"); // was red at bottom
  });
});

describe("colourblind-safe palette is available", () => {
  it("viridis produces different anchor colours", () => {
    const cfg: GradientConfig = { ...DEFAULT_GRADIENT_CONFIG, palette: "viridis" };
    expect(colorForCashFlow(1000, T, cfg).hex).toBe("#440154");
    expect(colorForCashFlow(3000, T, cfg).hex).toBe("#fde725");
  });
});

describe("legendStops", () => {
  it("exposes the anchor stops for the map legend", () => {
    const stops = legendStops();
    expect(stops.map((s) => s.ratio)).toEqual([1, 1.5, 2, 3]);
    expect(stops[0].hex).toBe("#d73027");
  });
});
