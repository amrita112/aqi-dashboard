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
  onRemove,
}: {
  index: number;
  prefs: Prefs;
  cities: EditorCity[];
  onPick: (p: TrendsPlace) => void;
  onCancel: () => void;
  onRemove?: () => void;
}) {
  const [cityName, setCityName] = useState<string | null>(
    index === 0 ? prefs.city : (cities[0]?.city ?? null),
  );
  const [mode, setMode] = useState<"city" | "point">("city");
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
        <div className="flex gap-3 text-sm">
          {onRemove && (
            <button type="button" onClick={onRemove} className="text-red-700 underline">
              Remove
            </button>
          )}
          <button type="button" onClick={onCancel} className="text-gray-600 underline">
            Cancel
          </button>
        </div>
      </div>

      {index !== 0 && (
        <button
          type="button"
          onClick={() => onPick(myPlace(prefs))}
          className="mt-3 w-full rounded-lg border border-gray-300 p-3 text-left text-sm"
        >
          <span className="font-medium">{prefs.anchor.name}</span>
          <span className="block text-gray-600">my saved place</span>
        </button>
      )}

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
          <div className="mt-3 flex gap-2">
            {(["city", "point"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium ${
                  mode === m ? "bg-gray-900 text-white" : "border border-gray-300 text-gray-700"
                }`}
              >
                {m === "city" ? "Whole city" : "A point on the map"}
              </button>
            ))}
          </div>

          {mode === "point" ? (
            <div className="mt-3 space-y-3">
              <LocationPicker
                centre={{ latitude: city.lat, longitude: city.lng }}
                city={city.city}
                value={picked}
                onChange={setPicked}
              />
              <button
                type="button"
                disabled={!picked}
                onClick={() => {
                  if (!picked) return;
                  onPick({
                    // The coordinates are in the key, so two points in one city
                    // are distinct series rather than overwriting each other.
                    key: `pt:${picked.latitude.toFixed(4)},${picked.longitude.toFixed(4)}`,
                    label: `${city.city} · ${picked.label}`,
                    query: {
                      lat: String(picked.latitude),
                      lng: String(picked.longitude),
                      k: String(NEAREST_K),
                    },
                  });
                }}
                className="w-full rounded-lg bg-blue-600 px-4 py-2.5 font-medium text-white disabled:opacity-40"
              >
                Use this place
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => onPick(cityPlace(city))}
              className="mt-3 w-full rounded-lg bg-blue-600 px-4 py-2.5 font-medium text-white"
            >
              Use {city.city} average
            </button>
          )}
        </>
      )}
    </div>
  );
}
