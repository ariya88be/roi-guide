"use client";

/**
 * The map IS the product (brief §2.6). A MapLibre map of cash-flow pins across
 * Greater Los Angeles, coloured by a continuous gradient relative to the user's
 * target. Filters (target, budget, all-cash, colourblind palette) refetch pins;
 * clicking a pin opens the "show the math" detail card.
 *
 * Phase-1 notes: keyless CARTO raster basemap (Voyager/Dark Matter; MapTiler/
 * Protomaps vector tiles in production). Dense areas cluster natively (MapLibre
 * `cluster: true` on the "pins" source) — clusters break apart as you zoom in,
 * so numbered pins never stack on top of each other.
 */
import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { interpolatePalette } from "@/lib/roi/color";

// Open centred on the Hollywood Hills, zoomed out enough to take in the whole
// coverage at a glance — coast (Santa Monica/Malibu) through the city and the
// San Fernando Valley east toward the Inland Empire. Clustering keeps this
// wide default readable instead of a wall of stacked pins.
const MAP_START = { lng: -118.34, lat: 34.13, zoom: 9 } as const;

// Keyless CARTO raster basemaps — a permissive dev/prod-friendly provider
// (OSM's own tile server forbids heavy/app use). Swap to MapTiler or Protomaps
// vector tiles (with a key) for the final polish. Voyager (day) / Dark Matter
// (night) share the same source id ("carto") so Night mode can just call
// setTiles() on the live source instead of rebuilding the whole style.
const LIGHT_TILES = ["a", "b", "c", "d"].map(
  (s) => `https://${s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png`,
);
const DARK_TILES = ["a", "b", "c", "d"].map((s) => `https://${s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png`);

function buildBasemapStyle(dark: boolean): maplibregl.StyleSpecification {
  return {
    version: 8,
    sources: {
      carto: {
        type: "raster",
        tiles: dark ? DARK_TILES : LIGHT_TILES,
        tileSize: 256,
        attribution: "© OpenStreetMap contributors © CARTO",
      },
    },
    layers: [{ id: "carto", type: "raster", source: "carto" }],
  };
}

/** True on first client render if the OS prefers dark — the Night-mode default. */
function prefersDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/**
 * A tiny "made by ariya" credit, implemented as a real MapLibre control (not an
 * absolutely-positioned React element) specifically so it STACKS directly
 * beneath the zoom +/- buttons in the same bottom-right corner group — MapLibre
 * owns that stacking/spacing, which is far more reliable than guessing Tailwind
 * offsets against it. Faint by default (a quiet credit, not a call to action);
 * full opacity on hover.
 */
class CreditControl implements maplibregl.IControl {
  private el: HTMLElement | null = null;
  onAdd(): HTMLElement {
    const el = document.createElement("div");
    el.className = "maplibregl-ctrl";
    const a = document.createElement("a");
    a.href = "https://www.ariya.be/me";
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = "made by ariya";
    a.style.cssText =
      "display:block;padding:3px 8px;font:500 11px/1.2 inherit;color:#374151;text-decoration:none;opacity:0.5;white-space:nowrap;background:rgba(255,255,255,0.7);border-radius:9999px;margin-top:4px;transition:opacity 0.15s;";
    a.onmouseenter = () => (a.style.opacity = "1");
    a.onmouseleave = () => (a.style.opacity = "0.5");
    el.appendChild(a);
    this.el = el;
    return el;
  }
  onRemove(): void {
    this.el?.remove();
    this.el = null;
  }
}

/**
 * Ordinal cluster grades, best → worst: A+, A, A-, B+, … Z-, i.e. 26 letters ×
 * {+, ·, −} = 78 unique grades. Clusters in view are RANKED by average deal
 * quality and assigned one grade each (exactly one A+, one A, …); if a view has
 * more than 78 clusters the surplus all take the last grade — Z- is the only
 * grade allowed to repeat.
 */
const CLUSTER_GRADES: string[] = (() => {
  const out: string[] = [];
  for (let i = 0; i < 26; i++) {
    const letter = String.fromCharCode(65 + i); // A..Z
    out.push(`${letter}+`, letter, `${letter}-`);
  }
  return out; // length 78: index 0 = "A+" (best) … index 77 = "Z-" (worst)
})();

/**
 * Rasterise a teardrop map-pin (the classic upside-down drop, tip at the
 * bottom) into an ImageData usable as a MapLibre SDF icon — so ONE shape can be
 * tinted per-feature by deal-quality colour via `icon-color`. The path is the
 * standard 24×24 pin; we render it filled white at 3× and hand the alpha mask
 * to MapLibre as an SDF (its edge antialiasing gives a clean tintable icon).
 * Returns null if a 2D canvas isn't available (SSR guard).
 */
function makePinImage(): ImageData | null {
  if (typeof document === "undefined") return null;
  const scale = 3;
  const w = 24 * scale;
  // Path spans y∈[2,22] (20 units tall); after translate(0,-2) the tip (y=22)
  // maps to device y=20*scale = the canvas bottom edge exactly, so an
  // icon-anchor:"bottom" symbol puts the tip precisely on the coordinate.
  const h = 20 * scale;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.scale(scale, scale);
  ctx.translate(0, -2); // shift so the path's y=2 top sits at the canvas top
  const pin = new Path2D("M12 2C7.58 2 4 5.58 4 10c0 5.5 8 12 8 12s8-6.5 8-12c0-4.42-3.58-8-8-8z");
  ctx.fillStyle = "#ffffff";
  ctx.fill(pin);
  return ctx.getImageData(0, 0, w, h);
}

interface Filters {
  target: number;
  /** Price floor/ceiling (inclusive); null = unbounded on that side. */
  budgetMin: number | null;
  budgetMax: number | null;
  /** "profit" = net monthly cash flow; "revenue" = gross monthly rent. */
  basis: "profit" | "revenue";
  allCash: boolean;
  palette: "rdylgn" | "viridis";
  downPaymentPct: number;
  annualRatePct: number;
  termMonths: number;
  vacancyPct: number;
  managementPct: number;
  maintenancePct: number;
  /** Single-family + 2-4 unit multifamily only; excludes any known HOA fee. */
  houseOnly: boolean;
}

const CONSERVATIVE = {
  downPaymentPct: 0.2,
  annualRatePct: 7,
  termMonths: 360,
  vacancyPct: 0.06,
  managementPct: 0.08,
  maintenancePct: 0.08,
} as const;

interface Detail {
  property: { address: string; propertyType: string; bedrooms: number; bathrooms: number };
  listing: { price: number; status: string; lastVerified: string; hoaFee: number | null };
  rent: { medianRent: number; basis: string };
  breakdown: Record<string, number>;
  flags: { hoaMissing: boolean; taxEstimated: boolean; insuranceEstimated: boolean };
  afterTax: { roughMonthly: number; disclaimer: string };
  investment: {
    cashInvested: number;
    cashOnCashPct: number | null;
    capRatePct: number | null;
    rentToPricePct: number | null;
  };
  confidence: { level: string; score: number; deEmphasize: boolean; note: string };
}

function assumptionQuery(f: Filters): string {
  const p = new URLSearchParams();
  p.set("target", String(f.target));
  if (f.budgetMin != null) p.set("budgetMin", String(f.budgetMin));
  if (f.budgetMax != null) p.set("budgetMax", String(f.budgetMax));
  p.set("basis", f.basis);
  p.set("allCash", f.allCash ? "true" : "false");
  p.set("palette", f.palette);
  p.set("downPaymentPct", String(f.downPaymentPct));
  p.set("annualRatePct", String(f.annualRatePct));
  p.set("termMonths", String(f.termMonths));
  p.set("vacancyPct", String(f.vacancyPct));
  p.set("managementPct", String(f.managementPct));
  p.set("maintenancePct", String(f.maintenancePct));
  p.set("houseOnly", f.houseOnly ? "true" : "false");
  return p.toString();
}

const money = (n: number) => (n < 0 ? `-$${Math.abs(n).toLocaleString()}` : `$${n.toLocaleString()}`);

/** A Zillow address-search link (ToS-safe deep link, not scraping). */
function zillowUrl(address: string): string {
  const slug = address.replace(/#/g, "").replace(/,/g, "").trim().replace(/\s+/g, "-");
  return `https://www.zillow.com/homes/${encodeURIComponent(slug)}_rb/`;
}

/** Escape untrusted text before injecting into a MapLibre popup's innerHTML. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Hover "sneak peek" content. We cannot embed Zillow's actual page (it blocks
 * iframing and we don't scrape it) — this is our OWN data, styled like a quick
 * preview card, so a user can gauge a pin before opening the real Zillow tab.
 */
function buildPreviewHtml(p: Record<string, unknown>, dark: boolean, basis: "profit" | "revenue"): string {
  const rank = Number(p.rank);
  const address = escapeHtml(String(p.address ?? "Unknown address"));
  const price = Number(p.price);
  const cashFlow = Number(p.cashFlow);
  // Headline number tracks the chosen basis, same as the list + target label.
  const primary = basis === "revenue" ? Number(p.medianRent) : cashFlow;
  const primarySuffix = basis === "revenue" ? "/mo rent" : "/mo";
  const capRatePct = Number(p.capRatePct);
  const localCapRatePct = Number(p.localCapRatePct);
  const relAdvantagePct = Number(p.relAdvantagePct);
  const color = escapeHtml(String(p.color ?? "#666"));
  const label = dealLabel(Number(p.dealScore));
  const relColor = relAdvantagePct >= 0 ? (dark ? "#4ade80" : "#15803d") : dark ? "#f87171" : "#dc2626";
  const textPrimary = dark ? "#f3f4f6" : "#111827";
  const textSecondary = dark ? "#d1d5db" : "#374151";
  const textMuted = dark ? "#9ca3af" : "#6b7280";
  const textFaint = dark ? "#6b7280" : "#9ca3af";
  return `
    <div style="min-width:210px;font-family:inherit">
      <div style="display:flex;align-items:center;gap:8px">
        <span style="background:${color};display:flex;height:22px;width:22px;align-items:center;justify-content:center;border-radius:9999px;font-size:11px;font-weight:700;color:#fff">${rank}</span>
        <span style="font-weight:600;color:${textPrimary};font-size:13px">${money(price)}</span>
      </div>
      <div style="margin-top:4px;font-size:12px;color:${textSecondary}">${address}</div>
      <div style="margin-top:4px;display:flex;justify-content:space-between;font-size:12px">
        <span style="font-weight:600;color:${dark ? "#4ade80" : "#15803d"}">${money(primary)}${primarySuffix}</span>
        <span style="color:${textMuted}">${capRatePct}% cap (area ${localCapRatePct}%)</span>
      </div>
      <div style="margin-top:2px;font-size:10px;color:${relColor}">${relAdvantagePct >= 0 ? "+" : ""}${relAdvantagePct}% vs area — ${label.text}</div>
      <div style="margin-top:4px;font-size:10px;color:${textFaint}">Click to view the listing →</div>
    </div>
  `;
}

// Default to all-cash so this cash-flow-tight market shows pins on first load;
// the financing toggle reveals the (honest) financed picture.
const INITIAL_FILTERS: Filters = {
  target: 1400,
  budgetMin: 45_000,
  budgetMax: 500_000,
  basis: "profit",
  allCash: true,
  palette: "rdylgn",
  houseOnly: false,
  ...CONSERVATIVE,
};

interface DealInfo {
  capRatePct: number;
  localCapRatePct: number;
  relAdvantagePct: number;
  dealScore: number;
  cluster: boolean;
  belowMarket: boolean;
}

/** One /api/pins GeoJSON feature — matches lib/pins/query.ts's PinFeature shape. */
interface PinFeature {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: {
    id: string;
    address: string;
    propertyType: string;
    bedrooms: number;
    bathrooms: number;
    price: number;
    cashFlow: number;
    medianRent: number;
    capRatePct: number;
    localCapRatePct: number;
    relAdvantagePct: number;
    dealScore: number;
    cluster: boolean;
    belowMarket: boolean;
    color: string;
    heatWeight: number;
    band: string;
    confidence: string;
    confidenceScore: number;
    deEmphasize: boolean;
    hoaMissing: boolean;
    rank: number;
    /** Oldest→newest price points for the sparkline; null until backfilled. */
    priceHistory: { date: string; price: number }[] | null;
  };
}

export default function MapView() {
  const mapContainer = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  // Latest filters, readable inside map event handlers without re-registering them.
  const filtersRef = useRef<Filters>(INITIAL_FILTERS);
  // Latest starredIds, readable inside fetchPins (a useCallback([]), so it
  // can't close over the state directly) to refresh the starred-property
  // cache whenever fresh data arrives — see fetchPins below.
  const starredIdsRef = useRef<Set<string>>(new Set());
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewPopupRef = useRef<maplibregl.Popup | null>(null);
  // Monotonic id for the latest fetch, so a slow earlier response can't
  // overwrite a newer one (pan + slider fire from independent debounces).
  const fetchSeqRef = useRef(0);
  // HTML markers that render each cluster's ordinal A+…Z- grade over its bubble
  // (an ordinal ranking can't be done in a MapLibre expression, and feature
  // state can't drive the layout text-field — so grades live in the DOM).
  const clusterGradeMarkersRef = useRef<maplibregl.Marker[]>([]);
  // Star markers for OUT-OF-FRAME starred properties — a plain HTML marker per
  // id, keyed so it can be added/removed as stars toggle or the property comes
  // back into the fetched viewport (where its normal numbered pin already
  // marks the spot, so the separate star marker steps aside).
  const starMarkersRef = useRef<Record<string, maplibregl.Marker>>({});
  // Heatmap gating: the glow only shows when the user has it on AND there are
  // enough homes in frame (>=4) for a density map to mean anything. showHeatRef
  // mirrors the checkbox; heatEligibleRef is recomputed on every idle from the
  // count of homes actually in view; applyHeatRef lets the checkbox effect
  // trigger the same visibility logic the idle handler owns.
  const showHeatRef = useRef(true);
  const heatEligibleRef = useRef(false);
  const applyHeatRef = useRef<() => void>(() => {});
  // Read by map event handlers (registered once at map init) so they see the
  // CURRENT Night-mode value rather than the one captured at setup time.
  const darkModeRef = useRef(false);

  const [filters, setFilters] = useState<Filters>(INITIAL_FILTERS);
  const [count, setCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [showHeat, setShowHeat] = useState(true);
  const [showRank, setShowRank] = useState(true);
  // Group nearby pins into graded clusters when zoomed out (on by default).
  // Off = every property shows as its own teardrop pin, no grouping.
  const [clusterPins, setClusterPins] = useState(true);
  const [dealInfo, setDealInfo] = useState<DealInfo | null>(null);
  const [scanned, setScanned] = useState<number | null>(null);
  const [eligible, setEligible] = useState<number | null>(null);
  const [scannedCapped, setScannedCapped] = useState(false);
  // The current viewport's RAW pins as fetched from the server (already
  // sorted best-deal-first), kept in React state so the expandable list below
  // the panel can render them — this also doubles as the "results-list
  // alternative" a map needs for screen readers.
  const [pinList, setPinList] = useState<PinFeature[]>([]);
  const [listExpanded, setListExpanded] = useState(false);
  // Mobile-only: the whole left panel starts collapsed to just its title bar
  // (tapping it expands/collapses) so opening on a phone doesn't immediately
  // bury the map under a full-height control panel. Irrelevant on desktop —
  // the panel body's `md:block` override always shows it there regardless of
  // this value, so defaulting to collapsed costs desktop nothing.
  const [panelExpanded, setPanelExpanded] = useState(false);
  // Properties the user chose to hide (an "eye" toggle in the list) — removed
  // from the map/ranking entirely, not just visually dimmed, and persists
  // across pans/zooms/refetches within the session.
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());
  // Starred properties — kept in the Properties list (and marked on the map)
  // across pans/zooms specifically so you can rate a home in one part of town
  // against another without losing track of either.
  const [starredIds, setStarredIds] = useState<Set<string>>(new Set());
  // Full feature data for every starred property, captured at star-time (or
  // refreshed whenever it's re-fetched) — needed so a starred property still
  // has an address/coords/price to show in the list and on the map after you
  // pan away and it drops out of `pinList`. Real state (not a ref) so it can
  // be read safely during render (combinedList below).
  const [starredFeatures, setStarredFeatures] = useState<Record<string, PinFeature>>({});
  // Lazy initializer: reads the OS preference once, only on the client.
  const [darkMode, setDarkMode] = useState<boolean>(prefersDark);

  // Keep the refs in sync with state (in an effect, never during render).
  useEffect(() => {
    filtersRef.current = filters;
  }, [filters]);
  useEffect(() => {
    darkModeRef.current = darkMode;
  }, [darkMode]);
  useEffect(() => {
    starredIdsRef.current = starredIds;
  }, [starredIds]);

  const toggleHidden = useCallback((id: string) => {
    setHiddenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    // Hiding a property also un-stars it — a hidden home isn't something
    // you're actively comparing, so it drops out of the starred set too.
    setStarredIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  /** Star/unstar. Takes the full feature (not just the id) so a snapshot of
   * its data survives after it drops out of `pinList` (e.g. you pan away).
   * Unstarring also drops its cached snapshot — the cache only ever needs to
   * hold data for CURRENTLY-starred ids. */
  const toggleStar = useCallback((f: PinFeature) => {
    const id = f.properties.id;
    setStarredIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        setStarredFeatures((sf) => {
          if (!(id in sf)) return sf;
          const nextSf = { ...sf };
          delete nextSf[id];
          return nextSf;
        });
      } else {
        next.add(id);
        setStarredFeatures((sf) => ({ ...sf, [id]: f }));
      }
      return next;
    });
  }, []);

  // Remove hidden properties entirely from the MAP (not shown, don't count
  // toward clusters) and re-rank what's left 1..N — rank always reflects what
  // the USER has chosen to see, not just what the server returned. This SAME
  // 1..N sequence is what the Properties list numbers too (see listRows) —
  // the two must never diverge, since the list doubles as the screen-reader
  // equivalent of "the numbers on the map" (QA §15.K).
  const visibleRanked = useMemo<PinFeature[]>(() => {
    const visible = pinList.filter((f) => !hiddenIds.has(f.properties.id));
    return visible.map((f, i) => ({ ...f, properties: { ...f.properties, rank: i + 1 } }));
  }, [pinList, hiddenIds]);

  // The IN-VIEW property list, numbered 1..N in EXACTLY the same order as the
  // map's pins (built from the same pinList + hiddenIds as visibleRanked
  // above) — never interleave anything else into this sequence, or its
  // numbers stop matching what's drawn on the map.
  interface ListRow {
    feature: PinFeature;
    hidden: boolean;
    displayRank: number | null;
  }
  const listRows = useMemo<ListRow[]>(() => {
    return pinList.reduce<{ rows: ListRow[]; visibleCount: number }>(
      (acc, f) => {
        const hidden = hiddenIds.has(f.properties.id);
        const visibleCount = hidden ? acc.visibleCount : acc.visibleCount + 1;
        return {
          visibleCount,
          rows: [...acc.rows, { feature: f, hidden, displayRank: hidden ? null : visibleCount }],
        };
      },
      { rows: [], visibleCount: 0 },
    ).rows;
  }, [pinList, hiddenIds]);
  const visibleListCount = useMemo(() => listRows.filter((r) => !r.hidden).length, [listRows]);

  // Starred properties that have panned OUT of the current view — shown in
  // their OWN section with NO rank number (a number here would falsely imply
  // it means the same thing as the map's "N on screen" ranking). Sorted by
  // deal score purely so the list has a stable, meaningful order.
  const starredElsewhere = useMemo<PinFeature[]>(() => {
    const inFrame = new Set(pinList.map((f) => f.properties.id));
    const out: PinFeature[] = [];
    for (const id of starredIds) {
      if (inFrame.has(id)) continue;
      const cached = starredFeatures[id];
      if (cached) out.push(cached);
    }
    return out.sort((a, b) => b.properties.dealScore - a.properties.dealScore);
  }, [pinList, starredIds, starredFeatures]);

  const fetchPins = useCallback(async () => {
    const map = mapRef.current;
    if (!map) return;
    const b = map.getBounds();
    const bbox = `${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()}`;
    const qs = `bbox=${bbox}&${assumptionQuery(filtersRef.current)}`;
    const seq = ++fetchSeqRef.current;
    setLoading(true);
    try {
      const res = await fetch(`/api/pins?${qs}`);
      if (!res.ok) return;
      const fc = await res.json();
      // Drop this response if a newer fetch has since started — otherwise a slow
      // earlier request (e.g. a big pan) could clobber a newer one's pins.
      if (seq !== fetchSeqRef.current) return;
      // The map source itself is synced by an effect keyed on `visibleRanked`
      // (below) — it also has to re-apply after a hide/unhide with no refetch.
      setCount(fc.features.length);
      setScanned(fc.scanned ?? null);
      setEligible(fc.eligible ?? null);
      setScannedCapped(Boolean(fc.scannedCapped));
      // Already sorted best-to-worst by the API (rank ascending) — re-ranked
      // again after hidden-property filtering in the visibleRanked memo.
      const features = fc.features as PinFeature[];
      setPinList(features);
      // Refresh the cached snapshot of every CURRENTLY-IN-FRAME starred
      // property with this fresh data — otherwise its cash flow/price/colour
      // would keep showing whatever it was at star-time even after you
      // change the target/budget/financing sliders (it only goes stale once
      // it actually pans OUT of frame, which is the tradeoff the feature is
      // for). Done here (data genuinely just arrived) rather than in an
      // effect keyed on pinList, which would be a same-tick derived-state
      // update better expressed as part of the fetch that produced it.
      if (starredIdsRef.current.size > 0) {
        setStarredFeatures((prev) => {
          let changed = false;
          const next = { ...prev };
          for (const f of features) {
            const id = f.properties.id;
            if (starredIdsRef.current.has(id) && prev[id] !== f) {
              next[id] = f;
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      }
    } finally {
      // Only the latest fetch owns the loading flag; a superseded one must not
      // flip it off while the newer request is still in flight.
      if (seq === fetchSeqRef.current) setLoading(false);
    }
  }, []);

  const openDetail = useCallback(async (id: string, deal: DealInfo | null) => {
    setDetailLoading(true);
    setDetail(null);
    setDealInfo(deal);
    try {
      const res = await fetch(`/api/property/${id}?${assumptionQuery(filtersRef.current)}`);
      if (res.ok) setDetail(await res.json());
    } finally {
      setDetailLoading(false);
    }
  }, []);

  /**
   * Shared "pick this property" action — opens its Zillow listing and loads
   * the detail card. Used by both a map-pin click and a list-row click, so the
   * two stay identical by construction rather than by two hand-kept copies.
   */
  const selectProperty = useCallback(
    (p: PinFeature["properties"]) => {
      window.open(zillowUrl(p.address), "_blank", "noopener,noreferrer");
      openDetail(p.id, {
        capRatePct: p.capRatePct,
        localCapRatePct: p.localCapRatePct,
        relAdvantagePct: p.relAdvantagePct,
        dealScore: p.dealScore,
        cluster: p.cluster,
        belowMarket: p.belowMarket,
      });
    },
    [openDetail],
  );

  /** List-row click: also fly the map to the property, since from a list you
   * don't yet know where on the map it is. */
  const selectAndFlyTo = useCallback(
    (f: PinFeature) => {
      mapRef.current?.flyTo({ center: f.geometry.coordinates, zoom: Math.max(mapRef.current.getZoom(), 14) });
      selectProperty(f.properties);
    },
    [selectProperty],
  );

  // Initialise the map once.
  useEffect(() => {
    if (mapRef.current || !mapContainer.current) return;
    const map = new maplibregl.Map({
      container: mapContainer.current,
      style: buildBasemapStyle(darkModeRef.current),
      center: [MAP_START.lng, MAP_START.lat],
      zoom: MAP_START.zoom,
      // Allow the WebGL canvas to be captured in screenshots/exports (MapLibre v5
      // nests WebGL context attributes under canvasContextAttributes).
      canvasContextAttributes: { preserveDrawingBuffer: true },
      // No default attribution control (the circled "i" toggle button reads as
      // obvious map-API chrome) — a plain, non-interactive text credit is
      // rendered instead (see the JSX below), since OSM/CARTO's free tiles
      // still require SOME visible attribution even without their own button.
      attributionControl: false,
    });
    mapRef.current = map;
    if (process.env.NODE_ENV !== "production") {
      (window as unknown as { __roiMap?: maplibregl.Map }).__roiMap = map;
    }
    // MapLibre PREPENDS new controls added to a bottom-* corner (the most
    // recently added one ends up closest to the TOP of that corner's stack,
    // not the bottom) — confirmed by inspecting the live DOM order, which is
    // the opposite of what a naive "added after = appears after" reading of
    // addControl would suggest. So CreditControl must be added FIRST for it
    // to land BELOW the zoom buttons, not above them.
    map.addControl(new CreditControl(), "bottom-right");
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");

    map.on("load", () => {
      // A teardrop map-pin as an SDF image so a single shape can be tinted
      // per-feature by deal-quality colour (icon-color) — the classic
      // upside-down teardrop, tip on the coordinate, number in the head.
      if (!map.hasImage("roi-pin")) {
        const pin = makePinImage();
        if (pin) map.addImage("roi-pin", pin, { sdf: true });
      }

      map.addSource("pins", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
        // Group overlapping pins into clusters when zoomed out — otherwise a
        // dense area is just numbers stacked on top of each other. Individual
        // pins take over past clusterMaxZoom. sum_score (dealScore summed per
        // cluster) lets the cluster bubble itself be colour-coded by its
        // AVERAGE deal quality (sum_score / point_count), not just a neutral
        // density colour — consistent with "colour = deal quality" everywhere
        // else in the app.
        cluster: true,
        clusterMaxZoom: 14,
        clusterRadius: 60,
        clusterProperties: {
          // Average deal quality drives the cluster bubble colour + grade rank.
          sum_score: ["+", ["get", "dealScore"]],
          // Separate good/bad mass so the heatmap can glow green where good
          // deals concentrate and red where bad ones do (a single density field
          // can't diverge). good = how far above the 0.5 midpoint, bad = below.
          sum_good: ["+", ["*", 2, ["max", 0, ["-", ["get", "dealScore"], 0.5]]]],
          sum_bad: ["+", ["*", 2, ["max", 0, ["-", 0.5, ["get", "dealScore"]]]]],
        },
      });

      // Clusters: a bubble sized by how many pins it holds, coloured by their
      // AVERAGE deal quality (same red->green ramp as individual pins).
      map.addLayer({
        id: "clusters-circle",
        type: "circle",
        source: "pins",
        filter: ["has", "point_count"],
        paint: {
          "circle-radius": [
            "interpolate",
            ["linear"],
            ["get", "point_count"],
            2, 16,
            10, 22,
            50, 30,
            200, 38,
          ],
          "circle-color": [
            "interpolate",
            ["linear"],
            ["/", ["get", "sum_score"], ["get", "point_count"]],
            0, "#d73027",
            0.333, "#fee08b",
            0.667, "#1a9850",
            1, "#006837",
          ],
          "circle-opacity": 0.88,
        },
      });
      // The cluster's GRADE (A+…Z-) is an ordinal rank across the clusters in
      // view — it can't be computed in a MapLibre expression, so it's rendered
      // as an HTML marker over each bubble (see rebuildClusterGrades below),
      // not a symbol layer here. The bubble's colour still shows ABSOLUTE
      // average quality; the letter shows RANK among what's on screen.

      // Clicking a cluster zooms in just enough to break it apart.
      map.on("click", "clusters-circle", async (e) => {
        const f = e.features?.[0];
        if (!f || f.geometry.type !== "Point") return;
        const clusterId = f.properties?.cluster_id;
        if (clusterId == null) return;
        const center = f.geometry.coordinates as [number, number];
        const src = map.getSource("pins") as maplibregl.GeoJSONSource;
        try {
          const zoom = await src.getClusterExpansionZoom(clusterId);
          map.easeTo({ center, zoom });
        } catch {
          // getClusterExpansionZoom can reject if the source/cluster tree is
          // mid-rebuild — just nudge in a level rather than leave an unhandled
          // rejection; the next click will resolve cleanly.
          map.easeTo({ center, zoom: Math.min(map.getZoom() + 2, 16) });
        }
      });
      map.on("mouseenter", "clusters-circle", () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", "clusters-circle", () => (map.getCanvas().style.cursor = ""));

      // DEAL-QUALITY heatmap: TWO overlaid layers so the overlay can diverge —
      // green where good-deal homes concentrate, red where bad ones do — which a
      // single density field can't express. Each is weighted by how good/bad the
      // points are (clusters use the aggregated sum_good / sum_bad). Only shown
      // when >=4 homes are in frame (see the idle handler's heat gating), so a
      // lone pin never glows. Fades out as you zoom in to individual pins.
      const HEAT = (id: string, weight: maplibregl.ExpressionSpecification, ramp: [number, string][]) =>
        ({
          id,
          type: "heatmap" as const,
          source: "pins",
          maxzoom: 14,
          paint: {
            "heatmap-weight": weight,
            "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 8, 1, 14, 2.4],
            "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 8, 34, 14, 70],
            "heatmap-opacity": ["interpolate", ["linear"], ["zoom"], 8, 0.6, 12, 0.4, 14, 0],
            "heatmap-color": ["interpolate", ["linear"], ["heatmap-density"], ...ramp.flat()],
          },
        }) as maplibregl.HeatmapLayerSpecification;
      const goodWeight: maplibregl.ExpressionSpecification = [
        "case",
        ["has", "point_count"],
        ["get", "sum_good"],
        ["*", 2, ["max", 0, ["-", ["get", "dealScore"], 0.5]]],
      ];
      const badWeight: maplibregl.ExpressionSpecification = [
        "case",
        ["has", "point_count"],
        ["get", "sum_bad"],
        ["*", 2, ["max", 0, ["-", 0.5, ["get", "dealScore"]]]],
      ];
      map.addLayer(
        HEAT("pins-heat-bad", badWeight, [
          [0, "rgba(0,0,0,0)"],
          [0.3, "rgba(215,48,39,0.25)"],
          [0.6, "rgba(215,48,39,0.5)"],
          [1, "rgba(165,0,38,0.72)"],
        ]),
      );
      map.addLayer(
        HEAT("pins-heat-good", goodWeight, [
          [0, "rgba(0,0,0,0)"],
          [0.3, "rgba(26,152,80,0.25)"],
          [0.6, "rgba(26,152,80,0.5)"],
          [1, "rgba(0,104,55,0.75)"],
        ]),
      );

      // Soft drop shadow: the same teardrop, tinted translucent black and
      // nudged down-right, drawn UNDER the coloured pin so it reads as a
      // shadow lifting the pin off the map (replaces the old white outline).
      // NOTE: deliberately NO icon-halo here — the source texture (makePinImage)
      // has no transparent padding around the shape, so a halo/blur has nowhere
      // to fade before hitting the texture edge, which showed up as a faint
      // rectangle under the pin. Plain translucent offset icon avoids that.
      const PIN_SIZE: maplibregl.ExpressionSpecification = [
        "interpolate",
        ["linear"],
        ["zoom"],
        8, 0.29,
        12, 0.39,
        16, 0.49,
      ];
      map.addLayer({
        id: "pins-shadow",
        type: "symbol",
        source: "pins",
        filter: ["!", ["has", "point_count"]],
        layout: {
          "icon-image": "roi-pin",
          "icon-anchor": "bottom",
          "icon-size": PIN_SIZE,
          "icon-offset": [3, 3], // down-right, in unscaled icon px
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
        paint: {
          "icon-color": "rgba(0,0,0,0.28)",
        },
      });
      // Teardrop map-pin per property, tip anchored on the coordinate, tinted
      // by the SAME deal-quality colour as the ranked list bubbles (rank 1 =
      // greenest, higher ranks steer toward red). Only unclustered points draw
      // here (clusters own the rest).
      map.addLayer({
        id: "pins-symbol",
        type: "symbol",
        source: "pins",
        filter: ["!", ["has", "point_count"]],
        layout: {
          "icon-image": "roi-pin",
          "icon-anchor": "bottom",
          "icon-size": PIN_SIZE,
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
        paint: {
          "icon-color": ["get", "color"],
          // ~20% fainter than a fully opaque pin, and fainter still when
          // already de-emphasised for a data-quality reason.
          "icon-opacity": ["case", ["get", "deEmphasize"], 0.45, 0.8],
        },
      });
      // Rank number, sitting in the pin's HEAD (offset up from the tip/coord).
      // 1 = best deal currently in frame, N = worst. Kept a separate layer so
      // the "Rating numbers on pins" toggle can hide it without hiding the pins.
      map.addLayer({
        id: "pins-label",
        type: "symbol",
        source: "pins",
        filter: ["!", ["has", "point_count"]],
        layout: {
          "text-field": ["to-string", ["get", "rank"]],
          "text-size": ["interpolate", ["linear"], ["zoom"], 8, 8, 16, 10],
          "text-font": ["Open Sans Bold"],
          // "center" (NOT "bottom") — with text-anchor:"bottom" the text's
          // BOTTOM edge sits at the offset point and the glyph extends upward
          // from there, so the visible number ends up well above wherever the
          // offset targets. "center" puts the glyph's own center exactly at
          // the offset point, matching the formula below directly.
          "text-anchor": "center",
          // Lift the number off the coordinate (the tip) into the pin's round
          // head — offset is in ems of text-size, so it's recomputed here
          // whenever PIN_SIZE or this layer's text-size changes: the head's
          // centre sits 60% of the way up the pin from the tip, i.e.
          // -(0.6 * 60 * iconSize) / textSize ems at each zoom stop.
          "text-offset": ["interpolate", ["linear"], ["zoom"], 8, ["literal", [0, -1.3]], 16, ["literal", [0, -1.8]]],
          "text-allow-overlap": true,
          "text-ignore-placement": true,
        },
        paint: { "text-color": "#ffffff", "text-halo-color": "rgba(0,0,0,0.35)", "text-halo-width": 1.2 },
      });

      // Grey ROI (cap rate) sub-label, once you zoom in a bit — the bold rank
      // number is the badge on the pin; this is the supporting number below it.
      map.addLayer({
        id: "pins-label-roi",
        type: "symbol",
        source: "pins",
        minzoom: 11,
        filter: ["!", ["has", "point_count"]],
        layout: {
          "text-field": ["concat", ["to-string", ["get", "capRatePct"]], "%"],
          "text-size": 10,
          "text-offset": [0, 1.5],
          "text-font": ["Open Sans Regular"],
          "text-allow-overlap": true,
          "text-ignore-placement": true,
        },
        paint: { "text-color": "#6b7280", "text-halo-color": "#ffffff", "text-halo-width": 0.7 },
      });

      // Heat glow sits ABOVE the cluster bubbles but UNDER the individual pins
      // (moved to just before pins-shadow, i.e. right after clusters-circle) —
      // the ordinal grade letters are separate DOM markers, always on top
      // regardless of this GL layer order, so they stay legible either way.
      map.moveLayer("pins-heat-bad", "pins-shadow");
      map.moveLayer("pins-heat-good", "pins-shadow");

      // Ordinal cluster grades (A+…Z-) as HTML markers over the bubbles. Rank
      // every cluster currently in view by average deal quality and label the
      // best A+, next A, next A-, … one grade each; surplus past 78 clusters all
      // get Z- (the only repeatable grade). Rebuilt whenever the clusters settle
      // (idle) and cleared while zooming (clusters merge/split — stale letters
      // would float over the wrong bubbles); a plain pan lets the markers track
      // their lng/lat, so no clear is needed there.
      const clearClusterGrades = () => {
        for (const mk of clusterGradeMarkersRef.current) mk.remove();
        clusterGradeMarkersRef.current = [];
      };
      // Show the heat layers only when the checkbox is on AND >=4 homes are in
      // frame — a heatmap over one or two homes is noise. Called from the idle
      // handler (recomputes the count) and from the checkbox effect.
      const HEAT_LAYERS = ["pins-heat-good", "pins-heat-bad"];
      const applyHeat = () => {
        const vis = showHeatRef.current && heatEligibleRef.current ? "visible" : "none";
        for (const id of HEAT_LAYERS) if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", vis);
      };
      applyHeatRef.current = applyHeat;
      const rebuildClusterGrades = () => {
        clearClusterGrades();
        if (!map.getLayer("clusters-circle")) return;
        const raw = map.querySourceFeatures("pins", { filter: ["has", "point_count"] });
        // Dedupe by cluster_id (a cluster can appear in several loaded tiles).
        const byId = new Map<number, { avg: number; coords: [number, number] }>();
        let homesInClusters = 0;
        for (const f of raw) {
          const id = f.properties?.cluster_id as number | undefined;
          if (id == null || byId.has(id) || f.geometry.type !== "Point") continue;
          const count = Number(f.properties?.point_count) || 1;
          homesInClusters += count;
          const avg = Number(f.properties?.sum_score ?? 0) / count;
          byId.set(id, { avg, coords: f.geometry.coordinates as [number, number] });
        }
        const ranked = [...byId.values()].sort((a, b) => b.avg - a.avg);
        for (let i = 0; i < ranked.length; i++) {
          const grade = CLUSTER_GRADES[Math.min(i, CLUSTER_GRADES.length - 1)];
          const el = document.createElement("div");
          el.textContent = grade;
          // pointer-events:none so a click falls through to the GL cluster layer
          // (which zooms in); the bubble underneath conveys the colour.
          el.style.cssText =
            "pointer-events:none;font-weight:700;font-size:13px;line-height:1;color:#fff;text-shadow:0 1px 2px rgba(0,0,0,0.6);white-space:nowrap;";
          const mk = new maplibregl.Marker({ element: el, anchor: "center" }).setLngLat(ranked[i].coords).addTo(map);
          clusterGradeMarkersRef.current.push(mk);
        }
        // Total homes in frame = those inside clusters + unclustered singles.
        const singles = new Set(
          map
            .querySourceFeatures("pins", { filter: ["!", ["has", "point_count"]] })
            .map((f) => f.properties?.id as string | undefined)
            .filter(Boolean),
        );
        heatEligibleRef.current = homesInClusters + singles.size >= 4;
        applyHeat();
      };
      map.on("zoomstart", clearClusterGrades);
      map.on("idle", rebuildClusterGrades);

      const INTERACTIVE_LAYERS = ["pins-symbol", "pins-label", "pins-label-roi"];

      // Hover: a quick "sneak peek" preview built from OUR OWN data (not an
      // embed of Zillow — it blocks iframing, and we don't scrape it).
      const previewPopup = new maplibregl.Popup({
        closeButton: false,
        closeOnClick: false,
        offset: 14,
        maxWidth: "240px",
        className: "roi-preview-popup",
      });
      previewPopupRef.current = previewPopup;
      const showPreview = (e: maplibregl.MapLayerMouseEvent) => {
        const f = e.features?.[0];
        if (!f || !f.properties || f.geometry.type !== "Point") return;
        previewPopup
          .setLngLat(f.geometry.coordinates as [number, number])
          .setHTML(buildPreviewHtml(f.properties, darkModeRef.current, filtersRef.current.basis))
          .addTo(map);
      };
      const hidePreview = () => previewPopup.remove();

      // Clicking a pin opens its listing directly (Zillow), and also updates the
      // side detail card with the full cash-flow / deal-quality breakdown — the
      // exact same action a list-row click triggers (see selectProperty above).
      const openListing = (e: maplibregl.MapLayerMouseEvent) => {
        const p = e.features?.[0]?.properties;
        const id = p?.id as string | undefined;
        if (!id || !p) return;
        previewPopup.remove();
        const bool = (v: unknown) => v === true || v === "true";
        selectProperty({
          id,
          address: String(p.address ?? ""),
          propertyType: String(p.propertyType ?? ""),
          bedrooms: Number(p.bedrooms),
          bathrooms: Number(p.bathrooms),
          price: Number(p.price),
          cashFlow: Number(p.cashFlow),
          medianRent: Number(p.medianRent),
          capRatePct: Number(p.capRatePct),
          localCapRatePct: Number(p.localCapRatePct),
          relAdvantagePct: Number(p.relAdvantagePct),
          dealScore: Number(p.dealScore),
          cluster: bool(p.cluster),
          belowMarket: bool(p.belowMarket),
          color: String(p.color ?? ""),
          heatWeight: Number(p.heatWeight),
          band: String(p.band ?? ""),
          confidence: String(p.confidence ?? ""),
          confidenceScore: Number(p.confidenceScore),
          deEmphasize: bool(p.deEmphasize),
          hoaMissing: bool(p.hoaMissing),
          rank: Number(p.rank),
          // Not read from the map feature (MapLibre stringifies nested arrays);
          // the detail card doesn't use it, and the list reads the real array
          // straight from React state.
          priceHistory: null,
        });
      };

      for (const layer of INTERACTIVE_LAYERS) {
        map.on("click", layer, openListing);
        map.on("mouseenter", layer, (e) => {
          map.getCanvas().style.cursor = "pointer";
          showPreview(e);
        });
        map.on("mousemove", layer, showPreview);
        map.on("mouseleave", layer, () => {
          map.getCanvas().style.cursor = "";
          hidePreview();
        });
      }

      fetchPins();
    });

    map.on("moveend", () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(fetchPins, 400);
    });

    return () => {
      for (const mk of clusterGradeMarkersRef.current) mk.remove();
      clusterGradeMarkersRef.current = [];
      map.remove();
      mapRef.current = null;
    };
  }, [fetchPins, openDetail, selectProperty]);

  // Push the hidden-filtered, re-ranked set into the map source — runs after
  // every fetch AND every hide/unhide toggle (no refetch needed for the latter,
  // since hiding is a client-side preference, not a server-side filter).
  useEffect(() => {
    const map = mapRef.current;
    const src = map?.getSource("pins") as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    src.setData({ type: "FeatureCollection", features: visibleRanked });
    // Data just changed under any hovered pin — drop the stale preview rather
    // than risk it showing a feature no longer in the visible set.
    previewPopupRef.current?.remove();
  }, [visibleRanked]);

  // Keep a yellow star marker on the map for every starred property that has
  // panned OUT of the current fetch — a property still in frame already has
  // its own numbered pin, so the separate star marker steps aside for it
  // (removed here) rather than doubling up at the same coordinate.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const inFrame = new Set(pinList.map((f) => f.properties.id));
    for (const [id, mk] of Object.entries(starMarkersRef.current)) {
      if (!starredIds.has(id) || inFrame.has(id)) {
        mk.remove();
        delete starMarkersRef.current[id];
      }
    }
    for (const id of starredIds) {
      if (inFrame.has(id) || starMarkersRef.current[id]) continue;
      const f = starredFeatures[id];
      if (!f) continue;
      const el = document.createElement("div");
      el.textContent = "★";
      el.style.cssText =
        "font-size:20px;line-height:1;color:#eab308;text-shadow:0 1px 2px rgba(0,0,0,0.55);pointer-events:none;";
      const mk = new maplibregl.Marker({ element: el, anchor: "center" }).setLngLat(f.geometry.coordinates).addTo(map);
      starMarkersRef.current[id] = mk;
    }
  }, [starredIds, pinList, starredFeatures]);

  // Unmount-only cleanup for the star markers (a separate effect so the
  // teardown doesn't fire on every starredIds/pinList change above).
  useEffect(() => {
    return () => {
      for (const mk of Object.values(starMarkersRef.current)) mk.remove();
      starMarkersRef.current = {};
    };
  }, []);

  // Refetch when filters change — debounced so typing/sliding doesn't spam the API.
  useEffect(() => {
    if (!mapRef.current?.isStyleLoaded()) return;
    const id = setTimeout(fetchPins, 350);
    return () => clearTimeout(id);
  }, [filters, fetchPins]);

  // Toggle the heat layers without refetching. Actual visibility also depends on
  // the in-frame home count (>=4), which the idle handler owns — so mirror the
  // checkbox into the ref and let the shared applyHeat decide.
  useEffect(() => {
    showHeatRef.current = showHeat;
    applyHeatRef.current();
  }, [showHeat]);

  // Toggle the rank-number badge on each pin (the "1 best ... N worst" rating).
  useEffect(() => {
    const map = mapRef.current;
    if (map?.getLayer("pins-label")) {
      map.setLayoutProperty("pins-label", "visibility", showRank ? "visible" : "none");
    }
  }, [showRank]);

  // Toggle clustering on the source itself. setClusterOptions preserves the
  // clusterProperties (sum_score/sum_good/sum_bad) set at creation and re-clusters the
  // data already in the source — so turning it OFF shows every property as its
  // own teardrop (no point_count ⇒ cluster layers empty, individual layers draw
  // everything), and turning it back ON regrades the clusters. Guarded against
  // the pre-load window where the source doesn't exist yet.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const src = map.getSource("pins") as maplibregl.GeoJSONSource | undefined;
      src?.setClusterOptions({ cluster: clusterPins, clusterMaxZoom: 14, clusterRadius: 60 });
    };
    if (map.getSource("pins")) apply();
    else map.once("load", apply);
  }, [clusterPins]);

  // Night mode: swap basemap tiles live via setTiles (no setStyle — that would
  // wipe the pins/heat/label layers, which aren't part of the style itself).
  // The 'carto' source only exists once the initial style finishes loading, so
  // toggling in that brief window (map not yet loaded) queues a one-time
  // listener instead of silently no-opping.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const source = map.getSource("carto") as maplibregl.RasterTileSource | undefined;
      source?.setTiles(darkMode ? DARK_TILES : LIGHT_TILES);
    };
    if (map.isStyleLoaded()) apply();
    else map.once("load", apply);
  }, [darkMode]);

  // Esc closes the detail card.
  useEffect(() => {
    if (!detail && !detailLoading) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDetail(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detail, detailLoading]);

  const gConf = { palette: filters.palette, direction: "higher-is-better" as const, belowTarget: "grey" as const };
  const gradientCss = `linear-gradient(90deg, ${[0, 0.25, 0.5, 0.75, 1]
    .map((t) => interpolatePalette(t, gConf))
    .join(", ")})`;

  return (
    <div className={`relative h-screen w-screen overflow-hidden ${darkMode ? "dark" : ""}`}>
      <div ref={mapContainer} className="h-full w-full" />

      {/* Map credit — OSM/CARTO's free tiles require attribution even with no
          attribution CONTROL button (see the map-init effect); both require an
          actual link where practical, not just visible text, so these ARE real
          anchors (deliberately not pointer-events-none). */}
      <div className="absolute bottom-1 right-1 z-10 text-[9px] text-gray-500/70 dark:text-gray-400/60">
        ©{" "}
        <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer" className="hover:underline">
          OpenStreetMap
        </a>{" "}
        ·{" "}
        <a href="https://carto.com/attributions" target="_blank" rel="noopener noreferrer" className="hover:underline">
          CARTO
        </a>
      </div>

      {/* Controls — full-width-ish near the top edge on mobile (collapsible),
          a fixed-width floating card on desktop (always fully shown). */}
      <div className="absolute left-2 right-2 top-2 z-10 max-h-[calc(100vh-1rem)] overflow-y-auto rounded-xl bg-white/75 p-4 shadow-lg backdrop-blur dark:bg-gray-900/70 dark:shadow-black/40 md:left-4 md:right-auto md:top-4 md:w-72">
        {/* Tapping anywhere here (except the day/night button) toggles the
            panel body on mobile; a plain div (not <button>) since it hosts a
            nested interactive control, which native <button> can't do. */}
        <div
          role="button"
          tabIndex={0}
          onClick={() => setPanelExpanded((v) => !v)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setPanelExpanded((v) => !v);
            }
          }}
          aria-expanded={panelExpanded}
          aria-controls="roi-panel-body"
          className="flex items-start justify-between gap-2 md:cursor-default"
        >
          <h1 className="text-base font-semibold text-gray-900 dark:text-gray-100">LA ROI Guide</h1>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setDarkMode((d) => !d);
              }}
              aria-label={darkMode ? "Switch to day mode" : "Switch to night mode"}
              title={darkMode ? "Day mode" : "Night mode"}
              className="rounded-full p-1 text-gray-500 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              {darkMode ? "☀️" : "🌙"}
            </button>
            <span className="text-[10px] text-gray-400 dark:text-gray-500 md:hidden" aria-hidden="true">
              {panelExpanded ? "▾" : "▸"}
            </span>
          </div>
        </div>
        <div id="roi-panel-body" className={panelExpanded ? "block" : "hidden md:block"}>
        <p className="mt-0.5 text-[11px] leading-tight text-gray-500 dark:text-gray-400">
          Set the monthly number you want. Pins are active listings that clear it, colored by how far.
          Coverage: Greater Los Angeles (the coast, the city, the San Fernando Valley, out to the Inland Empire).
        </p>
        <p className="mt-2 text-xs font-medium text-gray-700 dark:text-gray-300">
          {loading
            ? "Loading…"
            : count == null
              ? "Pan or zoom to load listings"
              : `${count} of ${eligible ?? count}${scannedCapped ? "+" : ""} listing${(eligible ?? count) === 1 ? "" : "s"} clear your target`}
        </p>
        {!loading && scannedCapped && (
          <p className="mt-1 text-[10px] leading-tight text-gray-400 dark:text-gray-500">
            This view is dense. Zoom in to see everything on screen.
          </p>
        )}
        {!loading && count === 0 && scanned === 0 && (
          <p className="mt-1 rounded-md bg-blue-50 px-2 py-1 text-[11px] leading-tight text-blue-700 dark:bg-blue-950/50 dark:text-blue-300">
            No coverage in this view yet. We cover Greater Los Angeles, from the coast out to the Inland Empire. Pan or zoom out.
          </p>
        )}
        {!loading && count === 0 && scanned != null && scanned > 0 && (
          <p className="mt-1 rounded-md bg-amber-50 px-2 py-1 text-[11px] leading-tight text-amber-700 dark:bg-amber-950/50 dark:text-amber-300">
            {filters.basis === "revenue"
              ? `${scanned} active listing${scanned === 1 ? "" : "s"} here, but none reach $${filters.target.toLocaleString()}/mo rent in your price range. Widen your budget or lower your target.`
              : `${scanned} active listing${scanned === 1 ? "" : "s"} here, but none clear $${filters.target.toLocaleString()}/mo cash flow${
                  filters.allCash ? "" : ` with ${Math.round(filters.downPaymentPct * 100)}% down @ ${filters.annualRatePct}%`
                } in your price range. Widen your budget or lower your target${filters.allCash ? "" : ", or try All-cash"}.`}
          </p>
        )}

        <div className="mt-3">
          <div className="flex items-center justify-between gap-2">
            <label htmlFor="roi-target" className="text-xs font-medium text-gray-700 dark:text-gray-300">
              Min monthly {filters.basis === "revenue" ? "rent" : "cash flow"}
            </label>
            <div
              className="flex overflow-hidden rounded-md border border-gray-300 text-[10px] font-medium dark:border-gray-600"
              role="group"
              aria-label="Show profit or revenue"
            >
              {(["profit", "revenue"] as const).map((b) => (
                <button
                  key={b}
                  type="button"
                  aria-pressed={filters.basis === b}
                  onClick={() => setFilters((f) => ({ ...f, basis: b }))}
                  className={`px-2 py-0.5 capitalize ${
                    filters.basis === b
                      ? "bg-green-600 text-white"
                      : "bg-transparent text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
                  }`}
                >
                  {b}
                </button>
              ))}
            </div>
          </div>
          <input
            id="roi-target"
            type="number"
            value={filters.target}
            min={1}
            step={50}
            onChange={(e) => setFilters((f) => ({ ...f, target: Math.max(1, Number(e.target.value) || 1) }))}
            className="mt-1 w-full rounded-md border border-gray-300 px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
          />
          <p className="mt-1 text-[10px] leading-tight text-gray-400 dark:text-gray-500">
            {filters.basis === "revenue"
              ? "Gross monthly rent, before any expenses."
              : "Net, after vacancy, management, maintenance/CapEx, mortgage P&I, property tax (estimated), insurance (estimated), and HOA."}
          </p>
        </div>

        <fieldset className="mt-3">
          <legend className="text-xs font-medium text-gray-700 dark:text-gray-300">Budget (price range)</legend>
          <div className="mt-1 flex items-center gap-2">
            <input
              type="number"
              aria-label="Minimum price"
              value={filters.budgetMin ?? ""}
              min={0}
              step={10000}
              placeholder="no min"
              onChange={(e) => {
                const v = Number(e.target.value);
                setFilters((f) => ({ ...f, budgetMin: e.target.value === "" || !(v > 0) ? null : v }));
              }}
              className="w-full rounded-md border border-gray-300 px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
            />
            <span className="text-xs text-gray-400 dark:text-gray-500">to</span>
            <input
              type="number"
              aria-label="Maximum price"
              value={filters.budgetMax ?? ""}
              min={0}
              step={10000}
              placeholder="no max"
              onChange={(e) => {
                const v = Number(e.target.value);
                setFilters((f) => ({ ...f, budgetMax: e.target.value === "" || !(v > 0) ? null : v }));
              }}
              className="w-full rounded-md border border-gray-300 px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
            />
          </div>
        </fieldset>

        <label className="mt-3 flex items-center gap-2 text-xs font-medium text-gray-700 dark:text-gray-300">
          <input
            type="checkbox"
            checked={filters.allCash}
            onChange={(e) => setFilters((f) => ({ ...f, allCash: e.target.checked }))}
          />
          All-cash purchase
          <span className="text-gray-400 dark:text-gray-500">(off = 20% down @ 7%)</span>
        </label>

        <label className="mt-2 flex items-center gap-2 text-xs font-medium text-gray-700 dark:text-gray-300">
          <input
            type="checkbox"
            checked={filters.houseOnly}
            onChange={(e) => setFilters((f) => ({ ...f, houseOnly: e.target.checked }))}
          />
          House
          <span className="text-gray-400 dark:text-gray-500">(no: HOA/condo/apt/manufactured)</span>
        </label>

        <label className="mt-2 flex items-center gap-2 text-xs font-medium text-gray-700 dark:text-gray-300">
          <input
            type="checkbox"
            checked={showHeat}
            onChange={(e) => setShowHeat(e.target.checked)}
          />
          Heatmap overlay
          <span className="text-gray-400 dark:text-gray-500">(zoom out)</span>
        </label>

        <label className="mt-2 flex items-center gap-2 text-xs font-medium text-gray-700 dark:text-gray-300">
          <input type="checkbox" checked={showRank} onChange={(e) => setShowRank(e.target.checked)} />
          Rating numbers on pins
          <span className="text-gray-400 dark:text-gray-500">(1 = best)</span>
        </label>

        <label className="mt-2 flex items-center gap-2 text-xs font-medium text-gray-700 dark:text-gray-300">
          <input type="checkbox" checked={clusterPins} onChange={(e) => setClusterPins(e.target.checked)} />
          Group into graded clusters
          <span className="text-gray-400 dark:text-gray-500">(off = every pin)</span>
        </label>

        <label className="mt-2 flex items-center gap-2 text-xs font-medium text-gray-700 dark:text-gray-300">
          <input
            type="checkbox"
            checked={filters.palette === "viridis"}
            onChange={(e) => setFilters((f) => ({ ...f, palette: e.target.checked ? "viridis" : "rdylgn" }))}
          />
          Colourblind-safe palette
        </label>

        {/* Assumption sliders — recompute cash flow live */}
        <details className="mt-3 border-t border-gray-200 pt-2 dark:border-gray-700">
          <summary className="cursor-pointer text-xs font-medium text-gray-700 dark:text-gray-300">Assumptions</summary>
          <div className="mt-1">
            <Slider
              label="Down payment"
              value={Math.round(filters.downPaymentPct * 100)}
              min={0}
              max={50}
              step={5}
              suffix="%"
              disabled={filters.allCash}
              onChange={(v) => setFilters((f) => ({ ...f, downPaymentPct: v / 100 }))}
            />
            <Slider
              label="Interest rate"
              value={filters.annualRatePct}
              min={0}
              max={12}
              step={0.25}
              suffix="%"
              disabled={filters.allCash}
              onChange={(v) => setFilters((f) => ({ ...f, annualRatePct: v }))}
            />
            <label className={`mt-2 block ${filters.allCash ? "opacity-40" : ""}`}>
              <span className="text-[11px] text-gray-600 dark:text-gray-400">Loan term</span>
              <select
                value={filters.termMonths}
                disabled={filters.allCash}
                onChange={(e) => setFilters((f) => ({ ...f, termMonths: Number(e.target.value) }))}
                className="mt-1 w-full rounded-md border border-gray-300 px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
              >
                <option value={180}>15 years</option>
                <option value={360}>30 years</option>
              </select>
            </label>
            <Slider
              label="Vacancy reserve"
              value={Math.round(filters.vacancyPct * 100)}
              min={0}
              max={15}
              step={1}
              suffix="%"
              onChange={(v) => setFilters((f) => ({ ...f, vacancyPct: v / 100 }))}
            />
            <Slider
              label="Management"
              value={Math.round(filters.managementPct * 100)}
              min={0}
              max={12}
              step={1}
              suffix="%"
              onChange={(v) => setFilters((f) => ({ ...f, managementPct: v / 100 }))}
            />
            <Slider
              label="Maintenance / CapEx"
              value={Math.round(filters.maintenancePct * 100)}
              min={0}
              max={15}
              step={1}
              suffix="%"
              onChange={(v) => setFilters((f) => ({ ...f, maintenancePct: v / 100 }))}
            />
            <button
              type="button"
              onClick={() => setFilters((f) => ({ ...f, ...CONSERVATIVE }))}
              className="mt-2 text-[11px] text-blue-600 hover:underline dark:text-blue-400"
            >
              Reset to conservative defaults
            </button>
          </div>
        </details>

        {/* Legend — colour = DEAL QUALITY (return on capital vs the local area) */}
        <div className="mt-4">
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
            Deal quality
          </div>
          <div className="h-3 w-full rounded" style={{ background: gradientCss }} />
          <div className="mt-1 flex justify-between text-[10px] text-gray-500 dark:text-gray-400">
            <span>Market-rate</span>
            <span>Local bargain</span>
          </div>
          <p className="mt-1 text-[10px] leading-tight text-gray-400 dark:text-gray-500">
            Green = high return for the price <em>and</em> a bargain vs nearby homes. Pins are numbered 1 (best) to N
            (worst) among what&apos;s on screen; it re-ranks as you pan or zoom. Hover a pin for a quick peek, then click
            to open its listing.
          </p>
        </div>

        {/* Expandable property list — same rank order as the pins; doubles as
            the results-list alternative a map needs for screen readers. */}
        <button
          type="button"
          onClick={() => setListExpanded((v) => !v)}
          aria-expanded={listExpanded}
          aria-controls="roi-property-list"
          className="mt-3 flex w-full items-center justify-between border-t border-gray-200 pt-2 text-xs font-medium text-gray-700 dark:border-gray-700 dark:text-gray-300"
        >
          <span>
            Properties ({visibleListCount}
            {hiddenIds.size > 0 ? ` · ${hiddenIds.size} hidden` : ""}
            {starredElsewhere.length > 0 ? ` · ${starredElsewhere.length} starred elsewhere` : ""})
          </span>
          <span
            className={`inline-block text-[10px] transition-transform ${listExpanded ? "rotate-180" : ""}`}
            aria-hidden="true"
          >
            ▾
          </span>
        </button>
        {listExpanded && (
          <div
            id="roi-property-list"
            className="mt-2 max-h-72 overflow-y-auto rounded-md border border-gray-200 dark:border-gray-700"
          >
            {listRows.length === 0 && starredElsewhere.length === 0 ? (
              <p className="p-2 text-[11px] text-gray-400 dark:text-gray-500">No properties in the current view.</p>
            ) : listRows.length === 0 ? (
              <p className="p-2 text-[11px] text-gray-400 dark:text-gray-500">
                No properties in the current view — see your starred properties below.
              </p>
            ) : (
              <ul className="divide-y divide-gray-100 dark:divide-gray-800">
                {listRows.map(({ feature: f, hidden, displayRank }) => (
                  <li key={f.properties.id} className="flex items-center">
                    {hidden ? (
                      <span className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 opacity-50">
                        <span
                          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-gray-300 dark:bg-gray-600"
                          aria-hidden="true"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[11px] text-gray-600 dark:text-gray-400">
                            {f.properties.address}
                          </span>
                          <span className="block text-[10px] text-gray-400 dark:text-gray-500">Hidden</span>
                        </span>
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => selectAndFlyTo(f)}
                        aria-label={`Rank ${displayRank}: ${f.properties.address}, ${money(
                          filters.basis === "revenue" ? f.properties.medianRent : f.properties.cashFlow,
                        )} per month ${filters.basis === "revenue" ? "rent" : "cash flow"}, priced ${money(f.properties.price)}`}
                        className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left hover:bg-gray-50 dark:hover:bg-gray-800"
                      >
                        <span
                          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white"
                          style={{ background: f.properties.color }}
                          aria-hidden="true"
                        >
                          {displayRank}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[11px] text-gray-800 dark:text-gray-200">
                            {f.properties.address}
                          </span>
                          <span className="block text-[10px] text-gray-500 dark:text-gray-400">
                            {money(filters.basis === "revenue" ? f.properties.medianRent : f.properties.cashFlow)}/mo · {money(f.properties.price)}
                          </span>
                        </span>
                        {/* Minimal price-history line (Zestimate-style), in the
                            trailing gap after the price. Null until backfilled. */}
                        <Sparkline points={(f.properties.priceHistory ?? []).map((h) => h.price)} />
                      </button>
                    )}
                    <span className="flex shrink-0 flex-col items-center">
                      <button
                        type="button"
                        onClick={() => toggleHidden(f.properties.id)}
                        aria-label={hidden ? `Show ${f.properties.address} on the map` : `Hide ${f.properties.address} from the map`}
                        title={hidden ? "Show on map" : "Hide from map"}
                        className="px-2 py-1 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                      >
                        {hidden ? <EyeOffIcon className="h-[10.5px] w-[10.5px]" /> : <EyeIcon className="h-[10.5px] w-[10.5px]" />}
                      </button>
                      {/* Starring keeps a home in this list (and marked on the
                          map) even after you pan elsewhere, so you can compare
                          it against homes elsewhere. Not available while
                          hidden — hiding already un-stars it (see toggleHidden). */}
                      {!hidden && (
                        <button
                          type="button"
                          onClick={() => toggleStar(f)}
                          aria-label={
                            starredIds.has(f.properties.id)
                              ? `Unstar ${f.properties.address}`
                              : `Star ${f.properties.address} to keep comparing it`
                          }
                          aria-pressed={starredIds.has(f.properties.id)}
                          title={starredIds.has(f.properties.id) ? "Unstar" : "Star to compare"}
                          className="px-2 py-1 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                        >
                          {starredIds.has(f.properties.id) ? (
                            <StarIcon className="h-[10.5px] w-[10.5px] text-yellow-500" filled />
                          ) : (
                            <StarIcon className="h-[10.5px] w-[10.5px]" />
                          )}
                        </button>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {/* Starred properties currently OUT of frame — deliberately NOT
                numbered (a rank here would falsely claim to mean the same
                thing as "N on screen") and clearly labelled, so this section
                can never be mistaken for contradicting the "no coverage in
                this view" message above. */}
            {starredElsewhere.length > 0 && (
              <div className="border-t border-gray-200 dark:border-gray-700">
                <p className="px-2 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500">
                  Starred, not in current view
                </p>
                <ul className="divide-y divide-gray-100 dark:divide-gray-800">
                  {starredElsewhere.map((f) => (
                    <li key={f.properties.id} className="flex items-center">
                      <button
                        type="button"
                        onClick={() => selectAndFlyTo(f)}
                        aria-label={`Starred, not in current view: ${f.properties.address}, ${money(
                          filters.basis === "revenue" ? f.properties.medianRent : f.properties.cashFlow,
                        )} per month ${filters.basis === "revenue" ? "rent" : "cash flow"}, priced ${money(f.properties.price)}. Click to fly there.`}
                        className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left hover:bg-gray-50 dark:hover:bg-gray-800"
                      >
                        <span
                          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white"
                          style={{ background: f.properties.color }}
                          aria-hidden="true"
                        >
                          <StarIcon className="h-3 w-3" filled />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[11px] text-gray-800 dark:text-gray-200">
                            {f.properties.address}
                          </span>
                          <span className="block text-[10px] text-gray-500 dark:text-gray-400">
                            {money(filters.basis === "revenue" ? f.properties.medianRent : f.properties.cashFlow)}/mo · {money(f.properties.price)}
                          </span>
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => toggleStar(f)}
                        aria-label={`Unstar ${f.properties.address}`}
                        title="Unstar"
                        className="shrink-0 px-2 py-1 text-yellow-500 hover:text-yellow-600"
                      >
                        <StarIcon className="h-[10.5px] w-[10.5px]" filled />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
        </div>
      </div>

      {/* Detail card */}
      {(detail || detailLoading) && (
        <div className="absolute right-4 top-4 z-10 max-h-[calc(100vh-2rem)] w-96 overflow-y-auto rounded-xl bg-white p-5 shadow-2xl dark:bg-gray-900 dark:shadow-black/50">
          <button
            onClick={() => setDetail(null)}
            className="float-right text-gray-400 hover:text-gray-700 dark:text-gray-500 dark:hover:text-gray-200"
            aria-label="Close"
          >
            ✕
          </button>
          {detailLoading && <p className="text-sm text-gray-500 dark:text-gray-400">Loading…</p>}
          {detail && <DetailCard detail={detail} deal={dealInfo} />}
        </div>
      )}
    </div>
  );
}

function EyeIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className={className} aria-hidden="true">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.01 9.963 7.183.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.01-9.963-7.178z"
      />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  );
}

function EyeOffIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className={className} aria-hidden="true">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.774 3.162 10.066 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243"
      />
    </svg>
  );
}

function StarIcon({ className, filled }: { className?: string; filled?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={filled ? 0 : 1.75}
      className={className}
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 2.75l2.94 5.96 6.58.96-4.76 4.64 1.12 6.55L12 17.77l-5.88 3.09 1.12-6.55-4.76-4.64 6.58-.96L12 2.75z"
      />
    </svg>
  );
}

/**
 * A minimal price-history line (no axes, no fill) for a list row — the shape of
 * the trend at a glance. Green if the latest price is at or above the first,
 * red if it has come down. Nothing renders with fewer than two points.
 */
function Sparkline({ points }: { points: number[] }) {
  if (!points || points.length < 2) return null;
  const w = 46;
  const h = 16;
  const pad = 1.5;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const step = (w - 2 * pad) / (points.length - 1);
  const coords = points.map((p, i) => {
    const x = pad + i * step;
    const y = pad + (h - 2 * pad) * (1 - (p - min) / range);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const dropped = points[points.length - 1] < points[0];
  const stroke = dropped ? "#dc2626" : "#16a34a";
  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      className="shrink-0 opacity-80"
      aria-hidden="true"
      preserveAspectRatio="none"
    >
      <polyline points={coords.join(" ")} fill="none" stroke={stroke} strokeWidth={1.25} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  suffix,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix: string;
  disabled?: boolean;
  onChange: (v: number) => void;
}) {
  return (
    <label className={`mt-2 block ${disabled ? "opacity-40" : ""}`}>
      <div className="flex justify-between text-[11px] text-gray-600 dark:text-gray-400">
        <span>{label}</span>
        <span className="font-medium tabular-nums">
          {value}
          {suffix}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1 h-4 w-full accent-green-600"
      />
    </label>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-gray-50 py-1.5 dark:bg-gray-800">
      <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">{value}</div>
      <div className="text-[10px] text-gray-500 dark:text-gray-400">{label}</div>
    </div>
  );
}

function dealLabel(score: number): { text: string; cls: string } {
  if (score >= 0.75)
    return { text: "Strong local bargain", cls: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300" };
  if (score >= 0.55)
    return { text: "Above the local average", cls: "bg-lime-100 text-lime-700 dark:bg-lime-900/40 dark:text-lime-300" };
  if (score >= 0.4)
    return { text: "Around market rate", cls: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300" };
  return { text: "Below-average deal", cls: "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300" };
}

function DetailCard({ detail, deal }: { detail: Detail; deal: DealInfo | null }) {
  const b = detail.breakdown;
  const cf = b.monthlyCashFlow;
  const line = (label: string, val: number, flag?: boolean) => (
    <div className="flex justify-between py-0.5">
      <span className="text-gray-600 dark:text-gray-400">
        {label}
        {flag && (
          <span className="ml-1 rounded bg-amber-100 px-1 text-[10px] text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
            estimated
          </span>
        )}
      </span>
      <span className="tabular-nums text-gray-900 dark:text-gray-100">
        {val < 0 ? `-$${Math.abs(val)}` : `$${val}`}
      </span>
    </div>
  );

  return (
    <div className="text-sm">
      <a
        href={zillowUrl(detail.property.address)}
        target="_blank"
        rel="noopener noreferrer"
        className="pr-6 text-base font-semibold text-blue-700 hover:underline dark:text-blue-400"
      >
        {detail.property.address}
      </a>
      <p className="text-xs text-gray-500 dark:text-gray-400">
        {detail.property.propertyType} · {detail.property.bedrooms}bd/{detail.property.bathrooms}ba ·{" "}
        {money(detail.listing.price)}
      </p>
      <a
        href={zillowUrl(detail.property.address)}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-2 inline-flex items-center gap-1 rounded-md bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-700"
      >
        View on Zillow ↗
      </a>

      <div className="mt-3 rounded-lg bg-gray-50 p-3 dark:bg-gray-800">
        <div className="text-xs text-gray-500 dark:text-gray-400">Monthly cash flow</div>
        <div className={`text-2xl font-bold ${cf >= 0 ? "text-green-700 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}>
          {money(cf)}/mo
        </div>
        <div className="mt-1 flex items-center gap-2">
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
              detail.confidence.level === "High"
                ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300"
                : detail.confidence.level === "Medium"
                  ? "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300"
                  : "bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-300"
            }`}
          >
            {detail.confidence.level} confidence ({detail.confidence.score})
          </span>
        </div>
        <p className="mt-1 text-[10px] leading-tight text-gray-500 dark:text-gray-400">{detail.confidence.note}</p>
      </div>

      {/* Investor metrics from data we already have */}
      <div className="mt-3 grid grid-cols-3 gap-2 text-center">
        <Metric
          label="Cash-on-cash"
          value={detail.investment.cashOnCashPct == null ? "—" : `${detail.investment.cashOnCashPct}%`}
        />
        <Metric label="Cap rate" value={detail.investment.capRatePct == null ? "—" : `${detail.investment.capRatePct}%`} />
        <Metric
          label="Rent / price"
          value={detail.investment.rentToPricePct == null ? "—" : `${detail.investment.rentToPricePct}%`}
        />
      </div>
      <p className="mt-1 text-[10px] text-gray-400 dark:text-gray-500">
        Cash invested: {money(detail.investment.cashInvested)}
      </p>

      {/* Deal quality — why this pin is the colour it is */}
      {deal && (
        <div className="mt-3 rounded-lg border border-gray-200 p-2.5 dark:border-gray-700">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
              Deal quality
            </span>
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${dealLabel(deal.dealScore).cls}`}>
              {dealLabel(deal.dealScore).text}
            </span>
          </div>
          <p className="mt-1.5 text-[11px] leading-snug text-gray-600 dark:text-gray-400">
            {deal.capRatePct}% return on price vs {deal.localCapRatePct}% for nearby homes —{" "}
            <span
              className={
                deal.relAdvantagePct >= 0
                  ? "font-medium text-green-700 dark:text-green-400"
                  : "font-medium text-red-600 dark:text-red-400"
              }
            >
              {deal.relAdvantagePct >= 0 ? "+" : ""}
              {deal.relAdvantagePct}% vs the area
            </span>
            .
          </p>
          {deal.cluster && (
            <p className="mt-1 rounded bg-amber-50 px-1.5 py-1 text-[10px] leading-tight text-amber-700 dark:bg-amber-950/50 dark:text-amber-300">
              ⚠ One of several near-identical nearby units — verify it isn&apos;t an overbuilt complex or an
              inflated rent estimate.
            </p>
          )}
          {deal.belowMarket && (
            <p className="mt-1 rounded bg-amber-50 px-1.5 py-1 text-[10px] leading-tight text-amber-700 dark:bg-amber-950/50 dark:text-amber-300">
              ⚠ Priced well below the area — verify condition / why it&apos;s cheap.
            </p>
          )}
        </div>
      )}

      <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
        How we calculated this
      </h3>
      <div className="mt-1">
        {line("Gross median rent", b.grossRent)}
        {line("− Vacancy reserve", -b.vacancy)}
        {line("− Management", -b.management)}
        {line("− Maintenance/CapEx", -b.maintenance)}
        {line("− Mortgage P&I", -b.mortgage)}
        {line("− Property tax", -b.propertyTax, detail.flags.taxEstimated)}
        {line("− Insurance", -b.insurance, detail.flags.insuranceEstimated)}
        {line(detail.flags.hoaMissing ? "− HOA (unknown → $0)" : "− HOA", -b.hoa, detail.flags.hoaMissing)}
        <div className="mt-1 flex justify-between border-t pt-1 font-semibold dark:border-gray-700">
          <span>Monthly cash flow</span>
          <span className={`tabular-nums ${cf >= 0 ? "text-green-700 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}>
            {money(cf)}
          </span>
        </div>
      </div>

      <p className="mt-2 text-[11px] text-gray-500 dark:text-gray-400">
        Rent basis: {detail.rent.basis} (${detail.rent.medianRent}/mo).
      </p>

      <div className="mt-3 rounded-lg bg-blue-50 p-2 text-xs dark:bg-blue-950/40">
        <div className="flex justify-between">
          <span className="text-gray-600 dark:text-gray-400">Rough after-tax</span>
          <span className="font-medium text-gray-900 dark:text-gray-100">{money(detail.afterTax.roughMonthly)}/mo</span>
        </div>
        <p className="mt-1 text-[10px] leading-tight text-gray-500 dark:text-gray-400">{detail.afterTax.disclaimer}</p>
      </div>

      <p className="mt-3 text-[10px] text-gray-400 dark:text-gray-500">
        Status: {detail.listing.status} · Last verified{" "}
        {new Date(detail.listing.lastVerified).toLocaleDateString()}
      </p>
    </div>
  );
}
