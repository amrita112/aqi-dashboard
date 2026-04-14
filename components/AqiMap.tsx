/**
 * AQI Map — displays AQI readings as colored markers on an interactive map.
 *
 * "use client" because maps require browser-side JavaScript to render.
 * Uses Leaflet (a map library) with OpenStreetMap tiles (free map images).
 *
 * Each marker is colored based on the EPA AQI scale:
 * green = good, yellow = moderate, red = unhealthy, etc.
 */
"use client";

import { useEffect } from "react";
import { MapContainer, TileLayer, CircleMarker, Popup, useMap } from "react-leaflet";
import "leaflet/dist/leaflet.css";  // Leaflet's styling (needed for the map to display correctly)
import { Reading } from "@/lib/types";
import { getAqiColor, getAqiLabel } from "@/lib/aqi-utils";

interface AqiMapProps {
  readings: Reading[];
  onMarkerClick?: (reading: Reading) => void;  // Optional callback when a marker is clicked
}

/**
 * Helper component that adjusts the map view to fit all markers.
 * "Fit bounds" means zoom/pan the map so all markers are visible.
 */
function FitBounds({ readings }: { readings: Reading[] }) {
  const map = useMap();  // Get a reference to the Leaflet map instance

  useEffect(() => {
    if (readings.length === 0) return;

    // Create a bounding box that contains all reading locations
    const bounds = readings.map(
      (r) => [r.latitude, r.longitude] as [number, number]
    );
    map.fitBounds(bounds, { padding: [50, 50] });  // 50px padding around the edges
  }, [readings, map]);

  return null;  // This component doesn't render anything visible
}

export default function AqiMap({ readings, onMarkerClick }: AqiMapProps) {
  return (
    <MapContainer
      // Default center: India (approximately Delhi)
      center={[20.5937, 78.9629]}
      zoom={5}
      className="h-full w-full rounded-lg"
      style={{ minHeight: "400px" }}
    >
      {/* TileLayer loads the actual map images from OpenStreetMap (free) */}
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />

      {/* Auto-zoom to fit all markers */}
      <FitBounds readings={readings} />

      {/* Render a colored circle for each reading */}
      {readings.map((reading) => (
        <CircleMarker
          key={reading.id}
          center={[reading.latitude, reading.longitude]}
          radius={10}
          fillColor={getAqiColor(reading.aqi_value)}  // Color based on EPA scale
          fillOpacity={0.8}
          color="#fff"       // White border around the circle
          weight={2}         // Border thickness
          eventHandlers={{
            click: () => onMarkerClick?.(reading),
          }}
        >
          {/* Popup that appears when you click a marker */}
          <Popup>
            <div className="text-center">
              <div className="text-lg font-bold">{reading.aqi_value}</div>
              <div className="text-sm">{getAqiLabel(reading.aqi_value)}</div>
              <div className="text-xs text-gray-500 mt-1">
                {new Date(reading.recorded_at).toLocaleString()}
              </div>
            </div>
          </Popup>
        </CircleMarker>
      ))}
    </MapContainer>
  );
}
