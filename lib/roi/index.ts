/**
 * ROI engine — public surface.
 *
 * The honest, pure, fully-tested core of ROI Guide. No I/O, no clock, no
 * randomness lives here. Everything downstream (API route handlers, ingestion
 * workers, UI) consumes these functions; nothing re-implements the maths.
 */

export * from "./statistics";
export * from "./amortization";
export * from "./defaults";
export * from "./cashflow";
export * from "./confidence";
export * from "./color";
export * from "./afterTax";
