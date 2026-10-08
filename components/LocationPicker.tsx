"use client";

/**
 * Pick a point on the map, and see which monitoring stations will be used.
 *
 * WHY A MAP AND NOT A STATION DROPDOWN. The dropdown asked people to choose a
 * monitoring station, which is a thing about our data rather than a thing about
 * their life — most people do not know which CPCB station is nearest their
 * flat, and picking the wrong one silently changes every number in the app.
 * A pin is the question they can actually answer.
 *
 * NO GEOLOCATION, unchanged from the original decision: no permission prompt,
 * no denial path, and someone in Delhi checking on family in Chennai stays a
 * first-class case. The pin starts at the city centre and they move it.
 *
 * NO GEOCODER EITHER, which is why the label is typed rather than looked up.
 * Reverse geocoding means a third-party service, a key, and a dependency that
 * can fail in the middle of the first screen. Defaulting the label to the
 * nearest station's area name gets it right often enough, and the field is
 * there when it does not.
 */

import { useEffect, useRef, useState } from "react";
import { MapContainer, TileLayer, Marker, Circle, Tooltip, useMapEvents } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { NEAREST_K } from "@/lib/prefs";

export interface NearbyStation {
  monitor_id: string;
  name: string;
  distance_km: number;
  latitude: number;
  longitude: number;
}

export interface PickedPlace {
  latitude: number;
  longitude: number;
  label: string;
  stations: NearbyStation[];
}

/**
 * Leaflet's default marker icons resolve to paths that do not exist under a
 * bundler, so both markers are drawn rather than loaded.
 *
 * The pin is the person's place; the dots are the stations their numbers will
 * come from. Listing the stations underneath but not drawing them left the map
 * showing a pin in an apparently empty city, which is the opposite of the point.
 */
const PIN = L.divIcon({
  className: "",
  html:
    '<div style="width:22px;height:22px;border-radius:50% 50% 50% 0;' +
    "background:#b3261e;border:3px solid #fff;transform:rotate(-45deg);" +
    'box-shadow:0 1px 4px rgba(0,0,0,.4)"></div>',
  iconSize: [22, 22],
  iconAnchor: [11, 22],
});

const STATION_DOT = L.divIcon({
  className: "",
  html:
    '<div style="width:12px;height:12px;border-radius:50%;background:#2a78d6;' +
    'border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.4)"></div>',
  iconSize: [12, 12],
  iconAnchor: [6, 6],
});


function ClickCatcher({ onPick }: { onPick: (lat: number, lng: number) => void }) {
  useMapEvents({
    click: (e) => onPick(e.latlng.lat, e.latlng.lng),
  });
  return null;
}

export default function LocationPicker({
  centre,
  city,
  value,
  onChange,
}: {
  centre: { latitude: number; longitude: number };
  city: string;
  value: PickedPlace | null;
  onChange: (p: PickedPlace | null) => void;
}) {
  const [point, setPoint] = useState<{ lat: number; lng: number } | null>(
    value ? { lat: value.latitude, lng: value.longitude } : null,
  );
  const [stations, setStations] = useState<NearbyStation[]>(value?.stations ?? []);
  const [label, setLabel] = useState(value?.label ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set when the user edits the label, so a later pin move stops overwriting it.
  const labelTouched = useRef(Boolean(value?.label));

  useEffect(() => {
    if (!point) return;
    let cancelled = false;
    setBusy(true);
    setError(null);
    (async () => {
      try {
        const res = await fetch(
          `/api/nearest?lat=${point.lat}&lng=${point.lng}&k=${NEAREST_K}`,
        );
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setError(body?.error?.message ?? "Could not find nearby stations.");
          setStations([]);
          return;
        }
        // /api/nearest returns `data` as a plain array, not an object.
        const found: NearbyStation[] = Array.isArray(body.data) ? body.data : [];
        setStations(found);
        if (!found.length) {
          setError("No monitoring station is near that point. Try somewhere closer to the city.");
        }
      } catch {
        if (!cancelled) setError("Could not reach the server.");
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [point]);

  // Report upward whenever the parts of a complete answer are all present.
  useEffect(() => {
    if (!point || !stations.length) {
      onChange(null);
      return;
    }
    const auto = stations[0].name.split(",")[0].trim();
    const finalLabel = (labelTouched.current ? label : auto).trim() || auto;
    onChange({
      latitude: point.lat,
      longitude: point.lng,
      label: finalLabel,
      stations,
    });
    if (!labelTouched.current && label !== auto) setLabel(auto);
    // onChange identity is not stable in the parent; depending on it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [point, stations, label]);

  const farthest = stations.length ? stations[stations.length - 1].distance_km : 0;

  return (
    <div className="space-y-3">
      <div className="h-64 w-full overflow-hidden rounded-md border border-gray-300">
        <MapContainer
          center={[centre.latitude, centre.longitude]}
          zoom={11}
          scrollWheelZoom={false}
          style={{ height: "100%", width: "100%" }}
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <ClickCatcher onPick={(lat, lng) => setPoint({ lat, lng })} />
          {point && <Marker position={[point.lat, point.lng]} icon={PIN} />}
          {/* The stations themselves. Named on hover/tap, so the list below and
              the map are obviously the same three things. */}
          {stations.map((st) =>
            typeof st.latitude === "number" && typeof st.longitude === "number" ? (
              <Marker
                key={st.monitor_id}
                position={[st.latitude, st.longitude]}
                icon={STATION_DOT}
              >
                <Tooltip direction="top" offset={[0, -6]}>
                  {st.name} · {st.distance_km.toFixed(1)} km
                </Tooltip>
              </Marker>
            ) : null,
          )}
          {/* The ring is the actual distance to the furthest station we would
              average, not a round number — so the neighbourhood the forecast
              comes from is visible rather than implied. */}
          {point && farthest > 0 && (
            <Circle
              center={[point.lat, point.lng]}
              radius={farthest * 1000}
              pathOptions={{ color: "#b3261e", weight: 1, dashArray: "4 4", fillOpacity: 0.04 }}
            />
          )}
        </MapContainer>
      </div>

      {!point && (
        <p className="text-sm text-gray-600">
          Tap the map to drop a pin where you spend your time in {city}.
        </p>
      )}

      {busy && <p className="text-sm text-gray-500">Finding the nearest stations…</p>}
      {error && <p className="text-sm text-red-700">{error}</p>}

      {!busy && !error && stations.length > 0 && (
        <div className="rounded-md border border-gray-200 bg-gray-50 p-3">
          <p className="text-sm font-medium text-gray-900">
            We will use {stations.length === 1 ? "this station" : `these ${stations.length} stations`}:
          </p>
          <ul className="mt-2 space-y-1 text-sm text-gray-700">
            {stations.map((s) => (
              <li key={s.monitor_id} className="flex justify-between gap-3">
                <span>{s.name}</span>
                <span className="shrink-0 tabular-nums text-gray-500">
                  {s.distance_km.toFixed(1)} km
                </span>
              </li>
            ))}
          </ul>
          <label htmlFor="place-label" className="mt-3 block text-sm font-medium text-gray-700">
            Call this place
          </label>
          <input
            id="place-label"
            value={label}
            onChange={(e) => {
              labelTouched.current = true;
              setLabel(e.target.value);
            }}
            className="mt-1 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm"
            placeholder="Home"
          />
        </div>
      )}
    </div>
  );
}
