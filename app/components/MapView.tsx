"use client";

/**
 * The map IS the product (brief §2.6). A MapLibre map of cash-flow pins over
 * San Bernardino, coloured by a continuous gradient relative to the user's
 * target. Filters (target, budget, all-cash, colourblind palette) refetch pins;
 * clicking a pin opens the "show the math" detail card.
 *
 * Phase-1 notes: keyless OSM raster basemap (MapTiler/Protomaps vector tiles in
 * production); no clustering yet (one ZIP ≈ 20 pins) — added when we scale ZIPs.
 */
import { useEffect, useRef, useState, useCallback } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { interpolatePalette } from "@/lib/roi/color";

// Start looking WEST of San Bernardino, along the SB→LA corridor (Fontana/Ontario belt).
const MAP_START = { lng: -117.5, lat: 34.03, zoom: 10 } as const;

// Keyless CARTO "Voyager" raster basemap — a permissive dev/prod-friendly
// provider (OSM's own tile server forbids heavy/app use). Swap to MapTiler or
// Protomaps vector tiles (with a key) for the final polish.
const BASEMAP_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    carto: {
      type: "raster",
      tiles: [
        "https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png",
        "https://b.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png",
        "https://c.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png",
        "https://d.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png",
      ],
      tileSize: 256,
      attribution: "© OpenStreetMap contributors © CARTO",
    },
  },
  layers: [{ id: "carto", type: "raster", source: "carto" }],
};

interface Filters {
  target: number;
  budget: number | null;
  allCash: boolean;
  palette: "rdylgn" | "viridis";
  downPaymentPct: number;
  annualRatePct: number;
  termMonths: number;
  vacancyPct: number;
  managementPct: number;
  maintenancePct: number;
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
  if (f.budget != null) p.set("budget", String(f.budget));
  p.set("allCash", f.allCash ? "true" : "false");
  p.set("palette", f.palette);
  p.set("downPaymentPct", String(f.downPaymentPct));
  p.set("annualRatePct", String(f.annualRatePct));
  p.set("termMonths", String(f.termMonths));
  p.set("vacancyPct", String(f.vacancyPct));
  p.set("managementPct", String(f.managementPct));
  p.set("maintenancePct", String(f.maintenancePct));
  return p.toString();
}

const money = (n: number) => (n < 0 ? `-$${Math.abs(n).toLocaleString()}` : `$${n.toLocaleString()}`);

/** A Zillow address-search link (ToS-safe deep link, not scraping). */
function zillowUrl(address: string): string {
  const slug = address.replace(/#/g, "").replace(/,/g, "").trim().replace(/\s+/g, "-");
  return `https://www.zillow.com/homes/${encodeURIComponent(slug)}_rb/`;
}

// Default to all-cash so this cash-flow-tight market shows pins on first load;
// the financing toggle reveals the (honest) financed picture.
const INITIAL_FILTERS: Filters = {
  target: 1400,
  budget: 500_000,
  allCash: true,
  palette: "rdylgn",
  ...CONSERVATIVE,
};

interface ColorScale {
  target: number;
  midAnchor: number;
  topAnchor: number;
}

export default function MapView() {
  const mapContainer = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  // Latest filters, readable inside map event handlers without re-registering them.
  const filtersRef = useRef<Filters>(INITIAL_FILTERS);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [filters, setFilters] = useState<Filters>(INITIAL_FILTERS);
  const [count, setCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [showHeat, setShowHeat] = useState(true);
  const [colorScale, setColorScale] = useState<ColorScale | null>(null);
  const [scanned, setScanned] = useState<number | null>(null);

  // Keep the ref in sync with state (in an effect, never during render).
  useEffect(() => {
    filtersRef.current = filters;
  }, [filters]);

  const fetchPins = useCallback(async () => {
    const map = mapRef.current;
    if (!map) return;
    const b = map.getBounds();
    const bbox = `${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()}`;
    const qs = `bbox=${bbox}&${assumptionQuery(filtersRef.current)}`;
    setLoading(true);
    try {
      const res = await fetch(`/api/pins?${qs}`);
      if (!res.ok) return;
      const fc = await res.json();
      const src = map.getSource("pins") as maplibregl.GeoJSONSource | undefined;
      if (src) src.setData(fc);
      setCount(fc.features.length);
      setScanned(fc.scanned ?? null);
      setColorScale(fc.colorScale ?? null);
    } finally {
      setLoading(false);
    }
  }, []);

  const openDetail = useCallback(async (id: string) => {
    setDetailLoading(true);
    setDetail(null);
    try {
      const res = await fetch(`/api/property/${id}?${assumptionQuery(filtersRef.current)}`);
      if (res.ok) setDetail(await res.json());
    } finally {
      setDetailLoading(false);
    }
  }, []);

  // Initialise the map once.
  useEffect(() => {
    if (mapRef.current || !mapContainer.current) return;
    const map = new maplibregl.Map({
      container: mapContainer.current,
      style: BASEMAP_STYLE,
      center: [MAP_START.lng, MAP_START.lat],
      zoom: MAP_START.zoom,
      // Allow the WebGL canvas to be captured in screenshots/exports (MapLibre v5
      // nests WebGL context attributes under canvasContextAttributes).
      canvasContextAttributes: { preserveDrawingBuffer: true },
    });
    mapRef.current = map;
    if (process.env.NODE_ENV !== "production") {
      (window as unknown as { __roiMap?: maplibregl.Map }).__roiMap = map;
    }
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");

    map.on("load", () => {
      map.addSource("pins", { type: "geojson", data: { type: "FeatureCollection", features: [] } });

      // Heat layer (under the pins): density of good-cash-flow listings. Fades
      // out as you zoom in so the labelled pins take over.
      map.addLayer({
        id: "pins-heat",
        type: "heatmap",
        source: "pins",
        maxzoom: 15,
        paint: {
          "heatmap-weight": ["get", "heatWeight"],
          "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 10, 1, 15, 3],
          "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 10, 22, 14, 42],
          "heatmap-opacity": ["interpolate", ["linear"], ["zoom"], 12, 0.85, 15, 0],
          "heatmap-color": [
            "interpolate",
            ["linear"],
            ["heatmap-density"],
            0, "rgba(0,0,0,0)",
            0.2, "rgba(215,48,39,0.5)",
            0.5, "rgba(254,224,139,0.7)",
            0.8, "rgba(26,152,80,0.85)",
            1, "rgba(0,104,55,0.95)",
          ],
        },
      });

      map.addLayer({
        id: "pins-circle",
        type: "circle",
        source: "pins",
        paint: {
          // Radius scales with cash flow (heatWeight) as well as zoom, so
          // magnitude reads before colour does.
          "circle-radius": [
            "*",
            ["interpolate", ["linear"], ["zoom"], 10, 4, 14, 9, 16, 13],
            ["+", 0.7, ["*", 0.9, ["get", "heatWeight"]]],
          ],
          "circle-color": ["get", "color"],
          "circle-opacity": ["case", ["get", "deEmphasize"], 0.6, 0.92],
          "circle-stroke-width": 1.5,
          "circle-stroke-color": "#ffffff",
        },
      });
      // Dollar label on each pin — colour is never the only signal (§8).
      map.addLayer({
        id: "pins-label",
        type: "symbol",
        source: "pins",
        minzoom: 12,
        layout: {
          "text-field": ["concat", "$", ["to-string", ["get", "cashFlow"]]],
          "text-size": 11,
          "text-offset": [0, 1.3],
          "text-font": ["Open Sans Regular"],
        },
        paint: { "text-color": "#111827", "text-halo-color": "#ffffff", "text-halo-width": 1.4 },
      });

      map.on("click", "pins-circle", (e) => {
        const id = e.features?.[0]?.properties?.id as string | undefined;
        if (id) openDetail(id);
      });
      map.on("mouseenter", "pins-circle", () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", "pins-circle", () => (map.getCanvas().style.cursor = ""));

      fetchPins();
    });

    map.on("moveend", () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(fetchPins, 400);
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [fetchPins, openDetail]);

  // Refetch when filters change — debounced so typing/sliding doesn't spam the API.
  useEffect(() => {
    if (!mapRef.current?.isStyleLoaded()) return;
    const id = setTimeout(fetchPins, 350);
    return () => clearTimeout(id);
  }, [filters, fetchPins]);

  // Toggle the heat layer without refetching.
  useEffect(() => {
    const map = mapRef.current;
    if (map?.getLayer("pins-heat")) {
      map.setLayoutProperty("pins-heat", "visibility", showHeat ? "visible" : "none");
    }
  }, [showHeat]);

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
    <div className="relative h-screen w-screen overflow-hidden">
      <div ref={mapContainer} className="h-full w-full" />

      {/* Controls */}
      <div className="absolute left-4 top-4 z-10 w-72 rounded-xl bg-white/95 p-4 shadow-lg backdrop-blur">
        <h1 className="text-base font-semibold text-gray-900">ROI Guide</h1>
        <p className="mt-0.5 text-[11px] leading-tight text-gray-500">
          Set the monthly profit you want — pins are active listings that clear it, colored by how far.
          Coverage: the Inland Empire, San Bernardino heading west toward LA.
        </p>
        <p className="mt-2 text-xs font-medium text-gray-700">
          {loading
            ? "Loading…"
            : count == null
              ? "Pan or zoom to load listings"
              : `${count} of ${scanned ?? count} listing${(scanned ?? count) === 1 ? "" : "s"} clear your target`}
        </p>
        {!loading && count === 0 && scanned === 0 && (
          <p className="mt-1 rounded-md bg-blue-50 px-2 py-1 text-[11px] leading-tight text-blue-700">
            No coverage in this view yet — we cover the Inland Empire west of San Bernardino. Pan east or zoom out.
          </p>
        )}
        {!loading && count === 0 && scanned != null && scanned > 0 && (
          <p className="mt-1 rounded-md bg-amber-50 px-2 py-1 text-[11px] leading-tight text-amber-700">
            {scanned} active listing{scanned === 1 ? "" : "s"} here, but none clear +${filters.target.toLocaleString()}/mo
            {filters.allCash ? "" : ` with ${Math.round(filters.downPaymentPct * 100)}% down @ ${filters.annualRatePct}%`}. Lower
            your target{filters.allCash ? "" : " or try All-cash"}.
          </p>
        )}

        <label className="mt-3 block text-xs font-medium text-gray-700">
          Min monthly cash flow (target)
          <input
            type="number"
            value={filters.target}
            min={1}
            step={50}
            onChange={(e) => setFilters((f) => ({ ...f, target: Math.max(1, Number(e.target.value) || 1) }))}
            className="mt-1 w-full rounded-md border border-gray-300 px-2 py-1 text-sm"
          />
        </label>

        <label className="mt-3 block text-xs font-medium text-gray-700">
          Max budget (optional)
          <input
            type="number"
            value={filters.budget ?? ""}
            min={0}
            step={10000}
            placeholder="no ceiling"
            onChange={(e) => {
              const v = Number(e.target.value);
              setFilters((f) => ({ ...f, budget: e.target.value === "" || !(v > 0) ? null : v }));
            }}
            className="mt-1 w-full rounded-md border border-gray-300 px-2 py-1 text-sm"
          />
        </label>

        <label className="mt-3 flex items-center gap-2 text-xs font-medium text-gray-700">
          <input
            type="checkbox"
            checked={filters.allCash}
            onChange={(e) => setFilters((f) => ({ ...f, allCash: e.target.checked }))}
          />
          All-cash purchase
          <span className="text-gray-400">(off = 20% down @ 7%)</span>
        </label>

        <label className="mt-2 flex items-center gap-2 text-xs font-medium text-gray-700">
          <input
            type="checkbox"
            checked={showHeat}
            onChange={(e) => setShowHeat(e.target.checked)}
          />
          Heatmap overlay
          <span className="text-gray-400">(zoom out)</span>
        </label>

        <label className="mt-2 flex items-center gap-2 text-xs font-medium text-gray-700">
          <input
            type="checkbox"
            checked={filters.palette === "viridis"}
            onChange={(e) => setFilters((f) => ({ ...f, palette: e.target.checked ? "viridis" : "rdylgn" }))}
          />
          Colourblind-safe palette
        </label>

        {/* Assumption sliders — recompute cash flow live */}
        <details className="mt-3 border-t border-gray-200 pt-2">
          <summary className="cursor-pointer text-xs font-medium text-gray-700">Assumptions</summary>
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
              <span className="text-[11px] text-gray-600">Loan term</span>
              <select
                value={filters.termMonths}
                disabled={filters.allCash}
                onChange={(e) => setFilters((f) => ({ ...f, termMonths: Number(e.target.value) }))}
                className="mt-1 w-full rounded-md border border-gray-300 px-2 py-1 text-sm"
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
              className="mt-2 text-[11px] text-blue-600 hover:underline"
            >
              Reset to conservative defaults
            </button>
          </div>
        </details>

        {/* Legend — labelled in dollars from the current viewport's scale */}
        <div className="mt-4">
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-gray-500">
            Monthly cash flow
          </div>
          <div className="h-3 w-full rounded" style={{ background: gradientCss }} />
          <div className="mt-1 flex justify-between text-[10px] text-gray-500">
            <span>{money(colorScale ? colorScale.target : filters.target)}</span>
            <span>{colorScale ? money(colorScale.midAnchor) : ""}</span>
            <span>{colorScale ? `${money(colorScale.topAnchor)}+` : ""}</span>
          </div>
          <p className="mt-1 text-[10px] leading-tight text-gray-400">
            Red = just clears your target; green = best in view.
          </p>
        </div>
      </div>

      {/* Detail card */}
      {(detail || detailLoading) && (
        <div className="absolute right-4 top-4 z-10 max-h-[calc(100vh-2rem)] w-96 overflow-y-auto rounded-xl bg-white p-5 shadow-2xl">
          <button
            onClick={() => setDetail(null)}
            className="float-right text-gray-400 hover:text-gray-700"
            aria-label="Close"
          >
            ✕
          </button>
          {detailLoading && <p className="text-sm text-gray-500">Loading…</p>}
          {detail && <DetailCard detail={detail} />}
        </div>
      )}
    </div>
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
      <div className="flex justify-between text-[11px] text-gray-600">
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
    <div className="rounded-md bg-gray-50 py-1.5">
      <div className="text-sm font-semibold text-gray-900">{value}</div>
      <div className="text-[10px] text-gray-500">{label}</div>
    </div>
  );
}

function DetailCard({ detail }: { detail: Detail }) {
  const b = detail.breakdown;
  const cf = b.monthlyCashFlow;
  const line = (label: string, val: number, flag?: boolean) => (
    <div className="flex justify-between py-0.5">
      <span className="text-gray-600">
        {label}
        {flag && <span className="ml-1 rounded bg-amber-100 px-1 text-[10px] text-amber-700">estimated</span>}
      </span>
      <span className="tabular-nums text-gray-900">{val < 0 ? `-$${Math.abs(val)}` : `$${val}`}</span>
    </div>
  );

  return (
    <div className="text-sm">
      <a
        href={zillowUrl(detail.property.address)}
        target="_blank"
        rel="noopener noreferrer"
        className="pr-6 text-base font-semibold text-blue-700 hover:underline"
      >
        {detail.property.address}
      </a>
      <p className="text-xs text-gray-500">
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

      <div className="mt-3 rounded-lg bg-gray-50 p-3">
        <div className="text-xs text-gray-500">Monthly cash flow</div>
        <div className={`text-2xl font-bold ${cf >= 0 ? "text-green-700" : "text-red-600"}`}>{money(cf)}/mo</div>
        <div className="mt-1 flex items-center gap-2">
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
              detail.confidence.level === "High"
                ? "bg-green-100 text-green-700"
                : detail.confidence.level === "Medium"
                  ? "bg-yellow-100 text-yellow-700"
                  : "bg-gray-200 text-gray-600"
            }`}
          >
            {detail.confidence.level} confidence ({detail.confidence.score})
          </span>
        </div>
        <p className="mt-1 text-[10px] leading-tight text-gray-500">{detail.confidence.note}</p>
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
      <p className="mt-1 text-[10px] text-gray-400">Cash invested: {money(detail.investment.cashInvested)}</p>

      <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-gray-500">How we calculated this</h3>
      <div className="mt-1">
        {line("Gross median rent", b.grossRent)}
        {line("− Vacancy reserve", -b.vacancy)}
        {line("− Management", -b.management)}
        {line("− Maintenance/CapEx", -b.maintenance)}
        {line("− Mortgage P&I", -b.mortgage)}
        {line("− Property tax", -b.propertyTax, detail.flags.taxEstimated)}
        {line("− Insurance", -b.insurance, detail.flags.insuranceEstimated)}
        {line(detail.flags.hoaMissing ? "− HOA (unknown → $0)" : "− HOA", -b.hoa, detail.flags.hoaMissing)}
        <div className="mt-1 flex justify-between border-t pt-1 font-semibold">
          <span>Monthly cash flow</span>
          <span className={`tabular-nums ${cf >= 0 ? "text-green-700" : "text-red-600"}`}>{money(cf)}</span>
        </div>
      </div>

      <p className="mt-2 text-[11px] text-gray-500">
        Rent basis: {detail.rent.basis} (${detail.rent.medianRent}/mo).
      </p>

      <div className="mt-3 rounded-lg bg-blue-50 p-2 text-xs">
        <div className="flex justify-between">
          <span className="text-gray-600">Rough after-tax</span>
          <span className="font-medium text-gray-900">{money(detail.afterTax.roughMonthly)}/mo</span>
        </div>
        <p className="mt-1 text-[10px] leading-tight text-gray-500">{detail.afterTax.disclaimer}</p>
      </div>

      <p className="mt-3 text-[10px] text-gray-400">
        Status: {detail.listing.status} · Last verified{" "}
        {new Date(detail.listing.lastVerified).toLocaleDateString()}
      </p>
    </div>
  );
}
