/**
 * Continuous cash-flow → colour mapping for map pins.
 *
 * Design change agreed with the product owner: instead of three hard buckets,
 * pins use a CONTINUOUS gradient keyed to how far a property's monthly cash
 * flow clears the user's target T. The brief's old band edges (T, 1.5T, 2T)
 * survive as named anchor STOPS on the gradient and as legend tick marks, so
 * the scale still reads meaningfully.
 *
 * Honesty / accessibility guarantees carried over from the brief (section 8):
 *  - colour is never the only signal — {@link classifyBand} gives a text label
 *    and every pin also renders its dollar figure;
 *  - a colourblind-safe palette ("viridis") is selectable;
 *  - palette DIRECTION is a single config flag, so we can flip to a
 *    conventional scale without touching call sites.
 *
 * Pure module.
 */

export type PaletteName = "rdylgn" | "viridis";
export type PaletteDirection = "higher-is-better" | "higher-is-worse";
export type BelowTargetRender = "grey" | "clampToStart";

export type Band = "below" | "meets" | "comfortable" | "strong";

type RGB = readonly [number, number, number];
interface GradientStop {
  /** Position in ratio space (cashFlow / target). */
  ratio: number;
  color: RGB;
}

/** Ratio at which the gradient saturates at its "best" end. */
const CLAMP_RATIO_MAX = 3;
/** Colour shown for below-target pins when rendered (rather than filtered out). */
const BELOW_TARGET_GREY: RGB = [154, 160, 166];

/**
 * Palette stops in ratio space. ratio 1.0 = exactly meets target,
 * 1.5 and 2.0 = the brief's original band edges, 3.0 = saturation.
 */
const PALETTES: Readonly<Record<PaletteName, readonly GradientStop[]>> = {
  // Red → amber → green. Intuitive, but red/green is the classic colourblind
  // trap — hence the dollar label + the viridis alternative.
  rdylgn: [
    { ratio: 1.0, color: [215, 48, 39] }, // #d73027 red  (meets minimum)
    { ratio: 1.5, color: [254, 224, 139] }, // #fee08b amber (comfortable)
    { ratio: 2.0, color: [26, 152, 80] }, // #1a9850 green (strong)
    { ratio: 3.0, color: [0, 104, 55] }, // #006837 deep green (well above)
  ],
  // Perceptually-uniform and colourblind-safe: dark purple → teal → yellow.
  viridis: [
    { ratio: 1.0, color: [68, 1, 84] }, // #440154
    { ratio: 1.5, color: [49, 104, 142] }, // #31688e
    { ratio: 2.0, color: [53, 183, 121] }, // #35b779
    { ratio: 3.0, color: [253, 231, 37] }, // #fde725
  ],
};

export interface GradientConfig {
  palette: PaletteName;
  direction: PaletteDirection;
  belowTarget: BelowTargetRender;
}

export const DEFAULT_GRADIENT_CONFIG: Readonly<GradientConfig> = Object.freeze({
  palette: "rdylgn",
  direction: "higher-is-better",
  belowTarget: "grey",
});

/**
 * Classify a cash flow into a named band relative to target T.
 * Inclusive lower bounds (the brief's semantics, made explicit for QA 15.C):
 *   below:       CF < T
 *   meets:       T   <= CF < 1.5T
 *   comfortable: 1.5T <= CF < 2T
 *   strong:      CF >= 2T
 */
export function classifyBand(cashFlow: number, target: number): Band {
  if (target <= 0) throw new RangeError(`classifyBand: target must be > 0, got ${target}`);
  if (cashFlow < target) return "below";
  if (cashFlow < 1.5 * target) return "meets";
  if (cashFlow < 2 * target) return "comfortable";
  return "strong";
}

function lerp(a: number, b: number, f: number): number {
  return a + (b - a) * f;
}

function lerpColor(a: RGB, b: RGB, f: number): RGB {
  return [
    Math.round(lerp(a[0], b[0], f)),
    Math.round(lerp(a[1], b[1], f)),
    Math.round(lerp(a[2], b[2], f)),
  ];
}

function toHex(rgb: RGB): string {
  return (
    "#" +
    rgb
      .map((c) => Math.max(0, Math.min(255, c)).toString(16).padStart(2, "0"))
      .join("")
  );
}

/**
 * When direction is "higher-is-worse", reverse the colour values while keeping
 * the ratio positions — a clean inversion of the mapping with no other change.
 */
function orientStops(stops: readonly GradientStop[], direction: PaletteDirection): GradientStop[] {
  if (direction === "higher-is-better") return [...stops];
  const colors = stops.map((s) => s.color).reverse();
  return stops.map((s, i) => ({ ratio: s.ratio, color: colors[i] }));
}

function evalStops(stops: readonly GradientStop[], ratio: number): RGB {
  const first = stops[0];
  const last = stops[stops.length - 1];
  if (ratio <= first.ratio) return first.color;
  if (ratio >= last.ratio) return last.color;
  for (let i = 0; i < stops.length - 1; i++) {
    const lo = stops[i];
    const hi = stops[i + 1];
    if (ratio >= lo.ratio && ratio <= hi.ratio) {
      const f = (ratio - lo.ratio) / (hi.ratio - lo.ratio);
      return lerpColor(lo.color, hi.color, f);
    }
  }
  return last.color; // unreachable, satisfies the type checker
}

export interface PinColor {
  hex: string;
  band: Band;
  /** cashFlow / target, clamped to [1, CLAMP_RATIO_MAX] for the gradient. */
  ratioClamped: number;
}

/**
 * Map a property's monthly cash flow to a pin colour, given the user's target.
 *
 * Below-target properties are normally filtered out of results entirely; when a
 * caller chooses to render them (e.g. Return-only mode debugging), `belowTarget`
 * controls whether they show as neutral grey or clamp to the gradient's start.
 */
export function colorForCashFlow(
  cashFlow: number,
  target: number,
  config: GradientConfig = DEFAULT_GRADIENT_CONFIG,
): PinColor {
  if (target <= 0) throw new RangeError(`colorForCashFlow: target must be > 0, got ${target}`);
  const band = classifyBand(cashFlow, target);
  const rawRatio = cashFlow / target;

  if (band === "below" && config.belowTarget === "grey") {
    return { hex: toHex(BELOW_TARGET_GREY), band, ratioClamped: Math.max(rawRatio, 0) };
  }

  const ratioClamped = Math.max(1, Math.min(CLAMP_RATIO_MAX, rawRatio));
  const stops = orientStops(PALETTES[config.palette], config.direction);
  return { hex: toHex(evalStops(stops, ratioClamped)), band, ratioClamped };
}

/** Legend entries (anchor stops) for the current palette/direction. */
export function legendStops(
  config: GradientConfig = DEFAULT_GRADIENT_CONFIG,
): Array<{ ratio: number; hex: string; label: string }> {
  const stops = orientStops(PALETTES[config.palette], config.direction);
  const labels: Record<number, string> = {
    1: "Meets target (T)",
    1.5: "1.5× target",
    2: "2× target",
    3: "3×+ target",
  };
  return stops.map((s) => ({ ratio: s.ratio, hex: toHex(s.color), label: labels[s.ratio] ?? `${s.ratio}× target` }));
}
