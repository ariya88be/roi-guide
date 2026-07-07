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
import { legendStops } from "@/lib/roi/color";

const SAN_BERNARDINO = { lng: -117.3, lat: 34.15, zoom: 12 } as const;

const BASEMAP_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution: "© OpenStreetMap contributors",
    },
  },
  layers: [{ id: "osm", type: "raster", source: "osm" }],
};

interface Filters {
  target: number;
  budget: number | null;
  allCash: boolean;
  palette: "rdylgn" | "viridis";
}

interface Detail {
  property: { address: string; propertyType: string; bedrooms: number; bathrooms: number };
  listing: { price: number; status: string; lastVerified: string; hoaFee: number | null };
  rent: { medianRent: number; basis: string };
  breakdown: Record<string, number>;
  flags: { hoaMissing: boolean; taxEstimated: boolean; insuranceEstimated: boolean };
  afterTax: { roughMonthly: number; disclaimer: string };
  confidence: { level: string; score: number; deEmphasize: boolean };
}

function assumptionQuery(f: Filters): string {
  const p = new URLSearchParams();
  p.set("target", String(f.target));
  if (f.budget != null) p.set("budget", String(f.budget));
  if (f.allCash) p.set("allCash", "true");
  p.set("palette", f.palette);
  return p.toString();
}

const money = (n: number) => (n < 0 ? `-$${Math.abs(n).toLocaleString()}` : `$${n.toLocaleString()}`);

// Default to all-cash so this cash-flow-tight market shows pins on first load;
// the financing toggle reveals the (honest) financed picture.
const INITIAL_FILTERS: Filters = { target: 100, budget: null, allCash: true, palette: "rdylgn" };

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
      center: [SAN_BERNARDINO.lng, SAN_BERNARDINO.lat],
      zoom: SAN_BERNARDINO.zoom,
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
      map.addLayer({
        id: "pins-circle",
        type: "circle",
        source: "pins",
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 6, 14, 11, 16, 15],
          "circle-color": ["get", "color"],
          "circle-opacity": ["case", ["get", "deEmphasize"], 0.55, 0.9],
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

  // Refetch when filters change.
  useEffect(() => {
    if (mapRef.current?.isStyleLoaded()) fetchPins();
  }, [filters, fetchPins]);

  const stops = legendStops({ palette: filters.palette, direction: "higher-is-better", belowTarget: "grey" });
  const gradientCss = `linear-gradient(90deg, ${stops.map((s) => s.hex).join(", ")})`;

  return (
    <div className="relative h-screen w-screen overflow-hidden">
      <div ref={mapContainer} className="h-full w-full" />

      {/* Controls */}
      <div className="absolute left-4 top-4 z-10 w-72 rounded-xl bg-white/95 p-4 shadow-lg backdrop-blur">
        <h1 className="text-base font-semibold text-gray-900">ROI Guide — San Bernardino</h1>
        <p className="mt-0.5 text-xs text-gray-500">
          {loading ? "Loading…" : count == null ? "" : `${count} propert${count === 1 ? "y" : "ies"} meet your target`}
        </p>
        {!loading && count === 0 && (
          <p className="mt-1 rounded-md bg-amber-50 px-2 py-1 text-[11px] leading-tight text-amber-700">
            Nothing clears +${filters.target.toLocaleString()}/mo here
            {filters.allCash ? "" : " with a loan at 7%"}. Try the All-cash toggle, lower your target, or pan the map.
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
            onChange={(e) =>
              setFilters((f) => ({ ...f, budget: e.target.value === "" ? null : Number(e.target.value) }))
            }
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
            checked={filters.palette === "viridis"}
            onChange={(e) => setFilters((f) => ({ ...f, palette: e.target.checked ? "viridis" : "rdylgn" }))}
          />
          Colourblind-safe palette
        </label>

        {/* Legend */}
        <div className="mt-4">
          <div className="h-3 w-full rounded" style={{ background: gradientCss }} />
          <div className="mt-1 flex justify-between text-[10px] text-gray-500">
            <span>meets (T)</span>
            <span>1.5T</span>
            <span>2T</span>
            <span>3T+</span>
          </div>
          <p className="mt-1 text-[10px] leading-tight text-gray-400">
            Colour = how far cash flow clears your target. Red still means “passes”.
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
      <h2 className="pr-6 text-base font-semibold text-gray-900">{detail.property.address}</h2>
      <p className="text-xs text-gray-500">
        {detail.property.propertyType} · {detail.property.bedrooms}bd/{detail.property.bathrooms}ba ·{" "}
        {money(detail.listing.price)}
      </p>

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
      </div>

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
