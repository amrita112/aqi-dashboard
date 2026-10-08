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
import { MapContainer, TileLayer, CircleMarker, Circle, Tooltip } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import {
  loadPrefs,
  MEASUREMENT_COPY,
  NEAREST_K,
  type Measurement,
  type Prefs,
} from "@/lib/prefs";
import { APP_NAME } from "@/lib/brand";
import StationDetail, { type DetailStation } from "@/components/StationDetail";

interface Station {
  value: number | null;
  pollutant?: string;
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


/** Grey, hollow: a station we hold nothing recent for. */
const NO_DATA = "#9ca3af";

export default function StationMap({
  // The home screen embeds a short map under the forecast; the Map tab wants
  // the tall one. A prop rather than a second component, so both stay the same
  // map with the same data and the same caveats.
  heightClass = "h-[60vh]",
}: {
  heightClass?: string;
} = {}) {
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [stations, setStations] = useState<Station[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Local to this screen. Switching the pollutant here changes what the map
  // shows and nothing else -- it is a way of looking, not a change of mind
  // about the setting chosen in setup.
  const [measurement, setMeasurement] = useState<Measurement>("aqi");
  const [selected, setSelected] = useState<DetailStation | null>(null);

  // Seeded from the person's own setting, then free to differ while they look.
  useEffect(() => {
    const p = loadPrefs();
    if (p) setMeasurement(p.measurement);
  }, []);

  useEffect(() => {
    const p = loadPrefs();
    if (!p) return;
    setPrefs(p);
    fetch(
      `/api/map?lat=${p.anchor.latitude}&lng=${p.anchor.longitude}` +
        `&radius_km=30&limit=80&pollutant=${measurement}`,
    )
      .then((r) => r.json())
      .then((b) => {
        if (b?.error) setError(b.error.message);
        else {
          setStations(b.data as Station[]);
        }
      })
      .catch(() => setError("Could not load the map."));
  }, [measurement]);

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
    <div className="space-y-0">
      <header className="mb-3 flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold tracking-tight">{APP_NAME}</h1>
        <select
          value={measurement}
          onChange={(e) => {
            setMeasurement(e.target.value as Measurement);
            setSelected(null);
          }}
          aria-label="Which pollutant to show"
          className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium"
        >
          <option value="aqi">{MEASUREMENT_COPY.aqi.short}</option>
          <option value="pm25">{MEASUREMENT_COPY.pm25.short}</option>
        </select>
      </header>

      <div className={`${heightClass} w-full overflow-hidden rounded-lg border border-gray-200`}>
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

          {/* What the forecast is actually averaged over. Kept at Amrita's
              request even though the sentence explaining it has gone: the ring
              shows it without needing a paragraph. */}
          <Circle
            center={centre}
            radius={averagingRadiusM}
            pathOptions={{ color: "#2a78d6", weight: 1, fillOpacity: 0.05, dashArray: "5 4" }}
          />

          <CircleMarker
            center={centre}
            radius={6}
            pathOptions={{ color: "#12171b", weight: 2, fillColor: "#fff", fillOpacity: 1 }}
          >
            <Tooltip permanent direction="top" offset={[0, -8]}>
              <span className="text-xs font-medium">Your place</span>
            </Tooltip>
          </CircleMarker>

          {(stations ?? []).map((st) => {
            const has = st.value !== null && st.band !== null;
            return (
              <CircleMarker
                key={st.monitor_id}
                center={[st.latitude, st.longitude]}
                radius={has ? 15 : 7}
                eventHandlers={{
                  click: () =>
                    setSelected({
                      monitor_id: st.monitor_id,
                      name: st.name,
                      city: st.city,
                      date: st.date,
                      age_days: st.age_days,
                    }),
                }}
                pathOptions={{
                  color: has ? "#12171b" : NO_DATA,
                  weight: has ? 1.5 : 1.5,
                  fillColor: has ? st.band!.color : "#ffffff",
                  // Hollow for no data: visibly different at a glance, not just
                  // a different shade of the same thing.
                  fillOpacity: has ? 0.95 : 0.15,
                }}
              >
                {has && (
                  <Tooltip
                    permanent
                    direction="center"
                    className="!border-0 !bg-transparent !shadow-none"
                  >
                    <span className="text-xs font-bold" style={{ color: st.band!.textColor }}>
                      {st.value}
                    </span>
                  </Tooltip>
                )}
              </CircleMarker>
            );
          })}
        </MapContainer>
      </div>

      {/* The station card, below the map rather than in a Leaflet popup: it
          holds a chart and a control, which a popup anchored to a dot cannot
          size sensibly on a phone. */}
      {selected && (
        <div className="mt-3">
          <StationDetail
            station={selected}
            measurement={measurement}
            onClose={() => setSelected(null)}
          />
        </div>
      )}

      {!selected && (
        <p className="mt-3 px-1 text-xs text-gray-500">
          Tap a station for its forecast and recent history.
        </p>
      )}
    </div>
  );
}
