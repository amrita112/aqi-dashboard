/**
 * /map — where the monitors are, and how stale each one is.
 *
 * A SERVER component so it can export `metadata`; client components cannot,
 * which is why this page previously showed the bare app name in the tab while
 * every other screen had a proper title.
 *
 * The map itself is a client component loaded with `ssr: false`, because
 * Leaflet reaches for `window` at import time and crashes a server render.
 */

import MapScreen from "@/components/MapScreen";

export const metadata = {
  title: "Monitors",
  description: "Every air quality station near you, and how recently each one reported.",
};

export default function MapPage() {
  return <MapScreen />;
}
