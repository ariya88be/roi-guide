"use client";

import dynamic from "next/dynamic";

// MapLibre must run in the browser only — load the map with SSR disabled.
const MapView = dynamic(() => import("./components/MapView"), { ssr: false });

export default function Home() {
  return <MapView />;
}
