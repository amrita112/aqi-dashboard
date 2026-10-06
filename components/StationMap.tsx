"use client";

/**
 * The map. Where the monitors are, what they last said, and how old that is.
 *
 * Three decisions worth knowing, because a map of coloured dots is unusually
 * good at implying things that are not true:
 *
 *   EVERY STATION IS DRAWN, including ones with nothing recent. They show
 *   hollow and grey. Dropping them would make the network look denser and
 *   healthier than it is, and where the gaps are is one of the more useful
 *   things this screen can show.
 *
 *   AGE IS ON EVERY MARKER, not just in a footnote. The median station near
 *   Delhi is four days old. A coloured dot invites the assumption that it is
 *   current, so each popup leads with when the reading is from.
 *
 *   THE ANCHOR IS MARKED and the averaging radius drawn, so it is visible that
 *   the forecast comes from a few nearby stations rather than from the one
 *   that happens to be closest.
 *
 * No geolocation, in keeping with the rest of the app — the map centres on the
 * place the person chose at first run.
 */

import { useEffect, useState } from "react";
import { MapContainer, TileLayer, CircleMarker, Circle, Popup, Tooltip } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import { loadPrefs, NEAREST_K, type Prefs } from "@/lib/prefs";

interface Station {
  monitor_id: string;
  name: string;
  city: string;
  latitude: number;
  longitude: number;
  distance_km: number;
  aqi: number | null;
  band: { label: string; color: string; textColor: string } | null;
  dominant_pollutant: string | null;
  date: string | null;
  age_days: number | null;
}

interface Meta {
  station_count: number;
  with_recent_data: number;
  median_age_days: number | null;
  lookback_days: number;
}

/** Grey, hollow: a station we hold nothing recent for. */
const NO_DATA = "#9ca3af";

export default function StationMap() {
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [stations, setStations] = useState<Station[] | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const p = loadPrefs();
    if (!p) return;
    setPrefs(p);
    fetch(`/api/map?lat=${p.anchor.latitude}&lng=${p.anchor.longitude}&radius_km=30&limit=80`)
      .then((r) => r.json())
      .then((b) => {
        if (b?.error) setError(b.error.message);
        else {
          setStations(b.data as Station[]);
          setMeta(b.meta as Meta);
        }
      })
      .catch(() => setError("Could not load the map."));
  }, []);

  if (!prefs) return <p className="text-gray-500">Loading…</p>;
  if (error) {
    return <p className="rounded-md bg-red-50 px-4 py-3 text-sm text-red-800">{error}</p>;
  }

  const centre: [number, number] = [prefs.anchor.latitude, prefs.anchor.longitude];
  // The distance to the furthest station the forecast actually averages over,
  // so the drawn circle matches what the app does rather than a round number.
  const withData = (stations ?? []).filter((s) => s.aqi !== null);
  const averagingRadiusM =
    withData.length >= NEAREST_K
      ? withData.slice(0, NEAREST_K).reduce((m, s) => Math.max(m, s.distance_km), 0) * 1000
      : 5000;

  return (
    <div className="space-y-3">
      <div className="h-[60vh] w-full overflow-hidden rounded-lg border border-gray-200">
        <MapContainer
          center={centre}
          zoom={11}
          scrollWheelZoom
          style={{ height: "100%", width: "100%" }}
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />

          {/* What the forecast is actually averaged over. */}
          <Circle
            center={centre}
            radius={averagingRadiusM}
            pathOptions={{ color: "#2a78d6", weight: 1, fillOpacity: 0.05, dashArray: "5 4" }}
          />

          {/* The place the person chose. */}
          <CircleMarker
            center={centre}
            radius={6}
            pathOptions={{ color: "#12171b", weight: 2, fillColor: "#fff", fillOpacity: 1 }}
          >
            <Tooltip permanent direction="top" offset={[0, -8]}>
              <span className="text-xs font-medium">Your place</span>
            </Tooltip>
          </CircleMarker>

          {(stations ?? []).map((s) => {
            const has = s.aqi !== null && s.band !== null;
            return (
              <CircleMarker
                key={s.monitor_id}
                center={[s.latitude, s.longitude]}
                radius={has ? 9 : 6}
                pathOptions={{
                  color: has ? "#ffffff" : NO_DATA,
                  weight: has ? 2 : 1.5,
                  fillColor: has ? s.band!.color : "#ffffff",
                  // Hollow for no data: visibly different at a glance, not just
                  // a different shade of the same thing.
                  fillOpacity: has ? 0.95 : 0.15,
                }}
              >
                <Popup>
                  <div className="min-w-[11rem]">
                    <p className="font-semibold">{s.name}</p>
                    {has ? (
                      <>
                        {/* Age first. A coloured dot already implies "now". */}
                        <p className="mt-1 text-xs text-gray-600">
                          {s.age_days === 0
                            ? "Measured today"
                            : `Measured ${s.age_days} day${s.age_days === 1 ? "" : "s"} ago`}
                          {" · "}
                          {s.date}
                        </p>
                        <p className="mt-2">
                          <span
                            className="rounded px-2 py-0.5 text-sm font-semibold"
                            style={{ background: s.band!.color, color: s.band!.textColor }}
                          >
                            {s.aqi} {s.band!.label}
                          </span>
                        </p>
                        <p className="mt-1 text-xs text-gray-600">
                          Driven by {s.dominant_pollutant?.toUpperCase()}
                          {" · "}
                          {s.distance_km} km away
                        </p>
                      </>
                    ) : (
                      <p className="mt-1 text-xs text-gray-600">
                        Nothing reported in the last {meta?.lookback_days ?? 14} days.
                        {" "}
                        {s.distance_km} km away.
                      </p>
                    )}
                  </div>
                </Popup>
              </CircleMarker>
            );
          })}
        </MapContainer>
      </div>

      {meta && (
        <p className="text-xs text-gray-600">
          {meta.with_recent_data} of {meta.station_count} stations within 30 km have
          reported in the last {meta.lookback_days} days
          {meta.median_age_days !== null && (
            <> — typically {meta.median_age_days} day
              {meta.median_age_days === 1 ? "" : "s"} old</>
          )}
          . Hollow circles are stations we hold nothing recent for. The dashed ring is
          what your forecast is averaged over.
        </p>
      )}

      {stations === null && <p className="text-sm text-gray-500">Loading stations…</p>}
    </div>
  );
}
