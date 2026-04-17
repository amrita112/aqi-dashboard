/**
 * Dashboard Page — the main view showing the AQI map and time series chart.
 *
 * "use client" because this page:
 * - Fetches data from Supabase when it loads
 * - Responds to user clicks on map markers
 * - Dynamically imports the map component (Leaflet doesn't work on the server)
 */
"use client";

import { useEffect, useState, useCallback } from "react";
import dynamic from "next/dynamic";  // For loading components only in the browser
import { createClient } from "@/lib/supabase/client";
import { getReadings, getReadingsNearLocation } from "@/lib/queries";
import { Reading, DataSource, ALL_SOURCES } from "@/lib/types";
import AqiTimeSeries from "@/components/AqiTimeSeries";
import AqiBadge from "@/components/AqiBadge";
import SourceFilter from "@/components/SourceFilter";

/**
 * Leaflet (the map library) uses browser APIs like `window` that don't exist on the server.
 * `dynamic` with `ssr: false` tells Next.js: "only load this component in the browser."
 * Without this, the app would crash during server-side rendering.
 */
const AqiMap = dynamic(() => import("@/components/AqiMap"), { ssr: false });

export default function DashboardPage() {
  const [readings, setReadings] = useState<Reading[]>([]);
  const [selectedReadings, setSelectedReadings] = useState<Reading[]>([]);  // Readings near a clicked marker
  const [activeSources, setActiveSources] = useState<DataSource[]>([...ALL_SOURCES]);  // All sources on by default
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const supabase = createClient();

  /**
   * Toggle a source on or off. If it's currently active, remove it.
   * If it's not active, add it. Then re-fetch data with the new filter.
   */
  const handleToggleSource = useCallback((source: DataSource) => {
    setActiveSources((prev) => {
      if (prev.includes(source)) {
        return prev.filter((s) => s !== source);  // Remove it
      } else {
        return [...prev, source];  // Add it
      }
    });
  }, []);

  // Fetch readings whenever the active sources change
  useEffect(() => {
    async function loadReadings() {
      setLoading(true);
      try {
        const data = await getReadings(supabase, 1000, activeSources);
        setReadings(data);
      } catch (err: any) {
        setError(err.message || "Failed to load readings");
      } finally {
        setLoading(false);
      }
    }
    loadReadings();
  }, [activeSources]);

  /**
   * When a marker is clicked on the map, fetch all readings near that location
   * and show them in the time series chart below.
   */
  const handleMarkerClick = async (reading: Reading) => {
    try {
      const nearby = await getReadingsNearLocation(
        supabase,
        reading.latitude,
        reading.longitude,
        5000  // 5 km radius
      );
      setSelectedReadings(nearby);
    } catch {
      // If the PostGIS function isn't available yet, just show the single reading
      setSelectedReadings([reading]);
    }
  };

  if (loading) {
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
          <AqiMap readings={readings} onMarkerClick={handleMarkerClick} />
        ) : (
          <div className="flex items-center justify-center h-full text-gray-500">
            No readings yet. Be the first to submit one!
          </div>
        )}
      </div>

      {/* Time series chart section */}
      <div className="bg-white border border-gray-200 rounded-lg p-6">
        <h2 className="text-lg font-semibold mb-4">
          {selectedReadings.length > 0
            ? "AQI Over Time (within 5 km of selected point)"
            : "AQI Over Time"}
        </h2>
        <AqiTimeSeries readings={selectedReadings} />
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
