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
 * first-class case.
 *
 * THE PIN STAYS STILL AND THE MAP MOVES (20 Oct). The pattern Uber, Ola,
 * Swiggy and Zomato use for "confirm your location", so most people here have
 * done it many times. The earlier version asked them to tap a search result to
 * drop a pin, and a tester did not realise the result was something to tap: he
 * typed his PIN code and nothing seemed to happen. Now a search moves the map
 * straight to the best match with the pin on it, and adjusting is a drag.
 * Dragging also beats tapping on a phone — a finger hides the spot it is
 * aiming at — and a pin fixed in the middle can never be off-screen.
 *
 * NO GEOCODER EITHER, which is why the label is typed rather than looked up.
 * Reverse geocoding means a third-party service, a key, and a dependency that
 * can fail in the middle of the first screen. Defaulting the label to the
 * nearest station's area name gets it right often enough, and the field is
 * there when it does not.
 */

import { useEffect, useRef, useState } from "react";
import {
  MapContainer,
  TileLayer,
  Marker,
  Circle,
  Tooltip,
  useMap,
  useMapEvents,
} from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { NEAREST_K } from "@/lib/prefs";
import PlaceSearch, { type SearchHit } from "@/components/PlaceSearch";

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
 * bundler, so the station dots are drawn rather than loaded. (The person's own
 * pin is not a map marker at all: it is drawn over the map's centre; see
 * CentrePin.)
 *
 * The dots are the stations their numbers will come from. Listing the stations underneath but not drawing them left the map
 * showing a pin in an apparently empty city, which is the opposite of the point.
 */

const STATION_DOT = L.divIcon({
  className: "",
  html:
    '<div style="width:12px;height:12px;border-radius:50%;background:#2a78d6;' +
    'border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.4)"></div>',
  iconSize: [12, 12],
  iconAnchor: [6, 6],
});


/** Zoom for a searched place or an existing pin: streets you can recognise. */
const STREET_ZOOM = 15;

/**
 * Drives the map: jumps to a searched place, and reports where the centre
 * ends up after the person moves it.
 *
 * Leaflet reads `center` ONCE, when the map is created, and ignores every
 * later change to it — so the jump is done here, with setView, rather than by
 * changing a prop that looks like it drives the map and does not.
 */
function MapController({
  jumpTo,
  onEngage,
  onCentre,
}: {
  /** A place to move to; a new object each search, so the same spot re-jumps. */
  jumpTo: { latitude: number; longitude: number } | null;
  /** The person has started choosing: dragged, tapped or zoomed by hand. */
  onEngage: () => void;
  /** The map has stopped moving with its centre here. */
  onCentre: (lat: number, lng: number) => void;
}) {
  const map = useMap();
  useEffect(() => {
    if (jumpTo) map.setView([jumpTo.latitude, jumpTo.longitude], STREET_ZOOM);
  }, [map, jumpTo]);
  useMapEvents({
    dragstart: onEngage,
    // A tap moves that spot under the pin — a second way to adjust, for
    // anyone who taps out of habit rather than dragging.
    click: (e) => {
      onEngage();
      map.panTo(e.latlng);
    },
    moveend: () => {
      const c = map.getCenter();
      onCentre(c.lat, c.lng);
    },
  });
  return null;
}

/**
 * The person's pin, fixed over the middle of the map. Its tip is the exact
 * centre, which is the point that gets saved. Ignores the pointer so drags go
 * straight through it to the map.
 */
function CentrePin({ faded }: { faded: boolean }) {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute left-1/2 top-1/2 z-[500]"
      // Up by its own height plus ~5px: the rotated square's tip pokes that
      // far below its box, and the TIP is what must sit on the centre.
      style={{ transform: "translate(-50%, calc(-100% - 5px))", opacity: faded ? 0.55 : 1 }}
    >
      <div
        style={{
          width: 26,
          height: 26,
          borderRadius: "50% 50% 50% 0",
          background: "#b3261e",
          border: "3px solid #fff",
          transform: "rotate(-45deg)",
          boxShadow: "0 1px 4px rgba(0,0,0,.4)",
        }}
      />
    </div>
  );
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
  /** Where a search put us; the map jumps there. */
  const [jumpTo, setJumpTo] = useState<{ latitude: number; longitude: number } | null>(null);
  /**
   * Whether the person has chosen anything yet. Until they search or move the
   * map, the pin sits on the city centre FADED and nothing is reported, so
   * nobody saves the city centre as "home" by pressing Next without looking.
   */
  const engaged = useRef(Boolean(value));
  const [isEngaged, setIsEngaged] = useState(Boolean(value));
  const engage = () => {
    engaged.current = true;
    setIsEngaged(true);
  };
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
      {/* SEARCH FIRST, MAP SECOND. The map is good at "is this the right
          spot?" and bad at "where am I?", which is the question first run was
          asking of everyone. */}
      <PlaceSearch
        near={centre}
        onPick={(hit: SearchHit) => {
          engage();
          setPoint({ lat: hit.latitude, lng: hit.longitude });
          // Moves the map AND zooms in, so what arrives is a street-level view
          // someone can recognise and adjust rather than the whole city again.
          setJumpTo({ latitude: hit.latitude, longitude: hit.longitude });
          // Their words for the place, not a monitoring site's name. They can
          // still edit it below.
          setLabel(hit.label);
          labelTouched.current = true;
        }}
      />

      <div className="relative h-72 w-full overflow-hidden rounded-md border border-gray-300">
        <MapContainer
          center={value ? [value.latitude, value.longitude] : [centre.latitude, centre.longitude]}
          zoom={value ? STREET_ZOOM : 11}
          scrollWheelZoom={false}
          style={{ height: "100%", width: "100%" }}
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <MapController
            jumpTo={jumpTo}
            onEngage={engage}
            onCentre={(lat, lng) => {
              if (engaged.current) setPoint({ lat, lng });
            }}
          />
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
        <CentrePin faded={!isEngaged} />
        {/* The instruction sits ON the map, where the eye already is. */}
        <p className="pointer-events-none absolute inset-x-0 top-2 z-[500] text-center">
          <span className="rounded-full bg-white/95 px-3 py-1 text-xs font-medium text-gray-800 shadow">
            {isEngaged
              ? "Move the map to adjust the pin"
              : `Search above, or move the map to your place in ${city}`}
          </span>
        </p>
      </div>

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
