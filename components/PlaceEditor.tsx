"use client";

/**
 * Choose a place for one of the Trends slots.
 *
 * WHY NOT A LIST OF CITIES. That was the first version, and it could only
 * answer "how does Mumbai compare with Delhi" — a question about two averages
 * of a few dozen stations each. The comparison people actually want is
 * "my street against my office", or "here against the place I am moving to",
 * and neither is a city.
 *
 * So a slot is one of three things:
 *   my place      the point saved at first run, three nearest stations
 *   a whole city  its centre with a wide net, labelled as an average
 *   a point       dropped on the map, three nearest stations to it
 *
 * The map is the same component the setup flow uses, so the stations it names
 * are the stations the forecast will average, by construction rather than by
 * agreement between two implementations.
 */

import { useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { NEAREST_K, type Prefs } from "@/lib/prefs";

const LocationPicker = dynamic(() => import("@/components/LocationPicker"), {
  ssr: false,
  loading: () => <div className="h-64 w-full animate-pulse rounded-md bg-gray-100" />,
});

export interface TrendsPlace {
  key: string;
  label: string;
  query: Record<string, string>;
}

export interface EditorCity {
  city: string;
  lat: number;
  lng: number;
}

/** A whole city: its centre, with a wide enough net to mean the city. */
const CITY_K = 10;
const CITY_MAX_KM = 60;

export function cityPlace(c: EditorCity): TrendsPlace {
  return {
    key: `city:${c.city}`,
    label: `${c.city} (city average)`,
    query: {
      lat: String(c.lat),
      lng: String(c.lng),
      k: String(CITY_K),
      max_km: String(CITY_MAX_KM),
      city: c.city,
    },
  };
}

/** A point inside a city: the three stations nearest it. */
export function pointPlace(
  c: EditorCity,
  picked: { latitude: number; longitude: number; label: string },
): TrendsPlace {
  return {
    // Coordinates in the key, so two points in one city are distinct series
    // rather than overwriting each other.
    key: `pt:${picked.latitude.toFixed(4)},${picked.longitude.toFixed(4)}`,
    label: `${c.city} · ${picked.label}`,
    query: {
      lat: String(picked.latitude),
      lng: String(picked.longitude),
      k: String(NEAREST_K),
    },
  };
}

export function myPlace(prefs: Prefs): TrendsPlace {
  return {
    key: "mine",
    label: prefs.anchor.name,
    query: {
      lat: String(prefs.anchor.latitude),
      lng: String(prefs.anchor.longitude),
      k: String(NEAREST_K),
    },
  };
}

export default function PlaceEditor({
  index,
  prefs,
  cities,
  onPick,
  onCancel,
  otherLabel,
}: {
  index: number;
  prefs: Prefs;
  cities: EditorCity[];
  onPick: (p: TrendsPlace) => void;
  onCancel: () => void;
  /** The other slot's label, so the button can name the comparison. */
  otherLabel: string;
}) {
  const [cityName, setCityName] = useState<string | null>(
    index === 0 ? prefs.city : (cities[0]?.city ?? null),
  );
  const [narrowing, setNarrowing] = useState(false);
  const [picked, setPicked] = useState<import("@/components/LocationPicker").PickedPlace | null>(
    null,
  );

  const city = useMemo(() => cities.find((c) => c.city === cityName) ?? null, [cities, cityName]);

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
          {index === 0 ? "First place" : "Compare with"}
        </h2>
        <button type="button" onClick={onCancel} className="text-sm text-gray-600 underline">
          Cancel
        </button>
      </div>


      <label htmlFor={`city-${index}`} className="mt-4 block text-sm font-medium text-gray-700">
        City
      </label>
      <select
        id={`city-${index}`}
        value={cityName ?? ""}
        onChange={(e) => {
          setCityName(e.target.value || null);
          setPicked(null);
        }}
        className="mt-1 w-full rounded-md border border-gray-300 bg-white px-3 py-2"
      >
        <option value="">Choose a city…</option>
        {cities.map((c) => (
          <option key={c.city} value={c.city}>
            {c.city}
          </option>
        ))}
      </select>

      {city && (
        <>
          {/* NO "whole city" BUTTON. Choosing a city above already means the
              city; offering it again as a mode made the city dropdown look
              like it had done nothing. Narrowing to a point is the only extra
              choice, so it is the only extra control. */}
          {!narrowing && !picked && (
            <button
              type="button"
              onClick={() => setNarrowing(true)}
              className="mt-3 w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-800"
            >
              Choose a specific location in {city.city}
            </button>
          )}

          {(narrowing || picked) && (
            <div className="mt-3 space-y-2">
              <LocationPicker
                centre={{ latitude: city.lat, longitude: city.lng }}
                city={city.city}
                value={picked}
                onChange={setPicked}
              />
              <button
                type="button"
                onClick={() => {
                  setNarrowing(false);
                  setPicked(null);
                }}
                className="text-sm text-gray-600 underline"
              >
                Use the whole of {city.city} instead
              </button>
            </div>
          )}

          <button
            type="button"
            onClick={() => onPick(picked ? pointPlace(city, picked) : cityPlace(city))}
            className="mt-3 w-full rounded-lg bg-blue-600 px-4 py-2.5 font-medium text-white"
          >
            {/* Says what is about to happen, rather than "Use this place" —
                which left it unclear what was being compared with what. */}
            Compare {otherLabel} to{" "}
            {picked ? `${city.city} · ${picked.label}` : `${city.city} (city average)`}
          </button>
        </>
      )}

    </div>
  );
}
