/**
 * Dashboard Page — the main view showing the AQI map and time series chart.
 *
 * "use client" because this page:
 * - Fetches data from Supabase when it loads
 * - Responds to user clicks on map markers and empty map space
 * - Tracks which location is selected and which sources are active
 * - Dynamically imports the map component (Leaflet doesn't work on the server)
 *
 * How the map ↔ timeline interaction works:
 * 1. The map shows colored markers for all readings matching the active source filters
 * 2. Clicking a marker loads timeline data for that station (within 5 km)
 * 3. Clicking empty space loads averaged data from a 10 km radius around that point
 * 4. Toggling source filters updates BOTH the map markers AND the timeline data
 * 5. The map does NOT re-zoom when filters change or points are clicked
 */
"use client";

import { useEffect, useState, useCallback } from "react";
import dynamic from "next/dynamic";
import { createClient } from "@/lib/supabase/client";
import { getReadings, getReadingsNearLocation } from "@/lib/queries";
import { Reading, DataSource, ALL_SOURCES } from "@/lib/types";
import { SelectedLocation } from "@/components/AqiMap";
import AqiTimeSeries from "@/components/AqiTimeSeries";
import AqiBadge from "@/components/AqiBadge";
import SourceFilter from "@/components/SourceFilter";

/**
 * Leaflet (the map library) uses browser APIs like `window` that don't exist on the server.
 * `dynamic` with `ssr: false` tells Next.js: "only load this component in the browser."
 * Without this, the app would crash during server-side rendering.
 */
const AqiMap = dynamic(() => import("@/components/AqiMap"), { ssr: false });

/** Search radius in meters for marker clicks (5 km) */
const STATION_RADIUS = 5000;
/** Search radius in meters for empty-space clicks (10 km) */
const AREA_RADIUS = 10000;

export default function DashboardPage() {
  const [readings, setReadings] = useState<Reading[]>([]);
  const [timelineReadings, setTimelineReadings] = useState<Reading[]>([]);
  const [selectedLocation, setSelectedLocation] = useState<SelectedLocation | null>(null);
  const [activeSources, setActiveSources] = useState<DataSource[]>([...ALL_SOURCES]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const supabase = createClient();

  /**
   * Toggle a source on or off. If it's currently active, remove it.
   * If it's not active, add it.
   */
  const handleToggleSource = useCallback((source: DataSource) => {
    setActiveSources((prev) =>
      prev.includes(source)
        ? prev.filter((s) => s !== source)
        : [...prev, source]
    );
  }, []);

  /**
   * Fetch all readings for the map markers whenever active sources change.
   */
  useEffect(() => {
    async function loadReadings() {
      setLoading(true);
      try {
        const data = await getReadings(supabase, 1000, activeSources);
        setReadings(data);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "Failed to load readings");
      } finally {
        setLoading(false);
      }
    }
    loadReadings();
  }, [activeSources]);

  /**
   * Fetches timeline data for a given lat/lng and radius, filtered by active sources.
   * The PostGIS function returns all sources, so we filter client-side.
   */
  const loadTimelineData = useCallback(
    async (lat: number, lng: number, radiusMeters: number) => {
      try {
        const nearby = await getReadingsNearLocation(supabase, lat, lng, radiusMeters);
        /* Filter to only the currently active sources */
        const filtered = nearby.filter((r) => activeSources.includes(r.source));
        setTimelineReadings(filtered);
      } catch {
        /* If PostGIS isn't set up yet, show an empty state rather than crashing */
        setTimelineReadings([]);
      }
    },
    [activeSources, supabase]
  );

  /**
   * When active sources change and a location is already selected,
   * re-fetch the timeline data so it stays in sync with the map.
   */
  useEffect(() => {
    if (selectedLocation) {
      loadTimelineData(
        selectedLocation.lat,
        selectedLocation.lng,
        selectedLocation.radiusMeters
      );
    }
  }, [activeSources]);

  /**
   * When a marker is clicked: select that station and load its nearby readings.
   * Uses a smaller radius (5 km) since we're looking at a specific station.
   */
  const handleMarkerClick = useCallback(
    (reading: Reading) => {
      const loc: SelectedLocation = {
        lat: reading.latitude,
        lng: reading.longitude,
        isStation: true,
        radiusMeters: STATION_RADIUS,
      };
      setSelectedLocation(loc);
      loadTimelineData(reading.latitude, reading.longitude, STATION_RADIUS);
    },
    [loadTimelineData]
  );

  /**
   * When empty map space is clicked: select that arbitrary point and load
   * averaged readings from a larger radius (10 km). This is for users who
   * want to know the AQI near their home even if there's no station there.
   */
  const handleMapClick = useCallback(
    (lat: number, lng: number) => {
      const loc: SelectedLocation = {
        lat,
        lng,
        isStation: false,
        radiusMeters: AREA_RADIUS,
      };
      setSelectedLocation(loc);
      loadTimelineData(lat, lng, AREA_RADIUS);
    },
    [loadTimelineData]
  );

  /**
   * Build the timeline chart title based on the selected location.
   * Shows lat/lng rounded to 2 decimal places so it's readable.
   */
  const timelineTitle = selectedLocation
    ? selectedLocation.isStation
      ? `Station readings near (${selectedLocation.lat.toFixed(2)}, ${selectedLocation.lng.toFixed(2)})`
      : `Area readings around (${selectedLocation.lat.toFixed(2)}, ${selectedLocation.lng.toFixed(2)})`
    : "AQI Over Time";

  if (loading && readings.length === 0) {
    return (
      <div className="flex items-center justify-center h-96 text-gray-500">
        Loading dashboard...
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-2xl mx-auto mt-10 p-6">
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-md">
          {error}
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto mt-6 px-6 space-y-6">
      {/* Header with summary stats */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">AQI Dashboard</h1>
        <span className="text-sm text-gray-500">
          {readings.length} reading{readings.length !== 1 ? "s" : ""} total
        </span>
      </div>

      {/* Source filter — toggle which data sources are shown */}
      <SourceFilter activeSources={activeSources} onToggle={handleToggleSource} />

      {/* Map section */}
      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden" style={{ height: "450px" }}>
        {readings.length > 0 ? (
          <AqiMap
            readings={readings}
            selectedLocation={selectedLocation}
            onMarkerClick={handleMarkerClick}
            onMapClick={handleMapClick}
          />
        ) : (
          <div className="flex items-center justify-center h-full text-gray-500">
            No readings yet. Be the first to submit one!
          </div>
        )}
      </div>

      {/* Hint text below the map */}
      <p className="text-sm text-gray-400 -mt-4">
        Click a station or anywhere on the map to see nearby AQI trends.
      </p>

      {/* Time series chart section */}
      <div className="bg-white border border-gray-200 rounded-lg p-6">
        <AqiTimeSeries readings={timelineReadings} title={timelineTitle} />
      </div>

      {/* Recent readings list */}
      {readings.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-lg p-6">
          <h2 className="text-lg font-semibold mb-4">Recent Readings</h2>
          <div className="space-y-3">
            {readings.slice(0, 10).map((reading) => (
              <div
                key={reading.id}
                className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0"
              >
                <div className="flex items-center gap-3">
                  <AqiBadge value={reading.aqi_value} />
                  <span className="text-sm text-gray-500">
                    ({reading.latitude.toFixed(2)}, {reading.longitude.toFixed(2)})
                  </span>
                </div>
                <span className="text-sm text-gray-400">
                  {new Date(reading.recorded_at).toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
