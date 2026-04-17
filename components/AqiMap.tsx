/**
 * AQI Map — displays AQI readings as colored markers on an interactive map,
 * and lets users select a location to view in the timeline chart.
 *
 * "use client" because maps require browser-side JavaScript to render.
 * Uses Leaflet (a map library) with OpenStreetMap tiles (free map images).
 *
 * The map serves two purposes:
 * 1. Data overview — shows all available reading locations as colored dots
 * 2. Area selector — click a marker or any spot to load timeline data for that area
 */
"use client";

import { useEffect, useRef } from "react";
import {
  MapContainer,
  TileLayer,
  CircleMarker,
  Circle,
  Marker,
  Popup,
  useMap,
  useMapEvents,
} from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { Reading } from "@/lib/types";
import { getAqiColor, getAqiLabel } from "@/lib/aqi-utils";

/**
 * Describes the point the user has selected on the map.
 * - lat/lng: the coordinates of the click
 * - isStation: true if they clicked an existing marker (vs. empty space)
 * - radiusMeters: the search radius shown on the map
 */
export interface SelectedLocation {
  lat: number;
  lng: number;
  isStation: boolean;
  radiusMeters: number;
}

interface AqiMapProps {
  readings: Reading[];
  selectedLocation: SelectedLocation | null;
  onMarkerClick?: (reading: Reading) => void;
  onMapClick?: (lat: number, lng: number) => void;
}

/**
 * Fits the map to show all markers, but only on the very first load.
 * After that, the user controls the view — toggling sources or clicking
 * markers won't cause the map to jump around.
 */
function InitialFitBounds({ readings }: { readings: Reading[] }) {
  const map = useMap();
  const hasFitted = useRef(false);

  useEffect(() => {
    /* Only fit once, and only when there are markers to fit to */
    if (hasFitted.current || readings.length === 0) return;

    const bounds = readings.map(
      (r) => [r.latitude, r.longitude] as [number, number]
    );
    map.fitBounds(bounds, { padding: [50, 50] });
    hasFitted.current = true;
  }, [readings, map]);

  return null;
}

/**
 * Invisible component that listens for clicks on empty map space
 * (not on a marker). Passes the clicked coordinates back to the dashboard.
 */
function MapClickHandler({ onClick }: { onClick: (lat: number, lng: number) => void }) {
  useMapEvents({
    click(e) {
      onClick(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

/**
 * A pulsing marker icon used to highlight the selected location.
 * Created once and reused for every selection.
 */
const selectedIcon = L.divIcon({
  className: "",
  html: `<div style="
    width: 16px; height: 16px;
    background: #3b82f6;
    border: 3px solid white;
    border-radius: 50%;
    box-shadow: 0 0 0 2px #3b82f6, 0 0 8px rgba(59,130,246,0.5);
  "></div>`,
  iconSize: [16, 16],
  iconAnchor: [8, 8],
});

export default function AqiMap({
  readings,
  selectedLocation,
  onMarkerClick,
  onMapClick,
}: AqiMapProps) {
  return (
    <MapContainer
      center={[20.5937, 78.9629]}
      zoom={5}
      className="h-full w-full rounded-lg"
      style={{ minHeight: "400px" }}
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />

      {/* Fit the map to all markers on first load only */}
      <InitialFitBounds readings={readings} />

      {/* Listen for clicks on empty map space */}
      {onMapClick && <MapClickHandler onClick={onMapClick} />}

      {/* Render a colored circle for each reading */}
      {readings.map((reading) => (
        <CircleMarker
          key={reading.id}
          center={[reading.latitude, reading.longitude]}
          radius={10}
          fillColor={getAqiColor(reading.aqi_value)}
          fillOpacity={0.8}
          color="#fff"
          weight={2}
          eventHandlers={{
            click: (e) => {
              /* Stop the click from also triggering the map-level click handler */
              L.DomEvent.stopPropagation(e.originalEvent);
              onMarkerClick?.(reading);
            },
          }}
        >
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

      {/* Show selection indicator: a blue marker and translucent radius circle */}
      {selectedLocation && (
        <>
          <Marker
            position={[selectedLocation.lat, selectedLocation.lng]}
            icon={selectedIcon}
          />
          {/* Translucent circle showing the area being queried for the timeline */}
          <Circle
            center={[selectedLocation.lat, selectedLocation.lng]}
            radius={selectedLocation.radiusMeters}
            pathOptions={{
              color: "#3b82f6",
              fillColor: "#3b82f6",
              fillOpacity: 0.1,
              weight: 1,
              dashArray: "4 4",
            }}
          />
        </>
      )}
    </MapContainer>
  );
}
