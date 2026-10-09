"use client";

/**
 * The three answers from first run, each editable on its own.
 *
 * EVERY CHANGE SAVES IMMEDIATELY. There is no Save button and no draft state:
 * each control writes to localStorage as it is used, the way a phone's own
 * settings behave. A Save button would invite someone to change two things,
 * miss the button, and lose both.
 *
 * The location editor is the setup map, reused rather than reimplemented, so
 * the two can never drift into showing different stations for the same point.
 */

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import {
  clearPrefs,
  loadPrefs,
  savePrefs,
  MEASUREMENT_COPY,
  NEAREST_K,
  type Measurement,
  type Prefs,
} from "@/lib/prefs";
import { APP_NAME } from "@/lib/brand";
import CityRequestForm from "@/components/CityRequestForm";

const LocationPicker = dynamic(() => import("@/components/LocationPicker"), {
  ssr: false,
  loading: () => <div className="h-64 w-full animate-pulse rounded-md bg-gray-100" />,
});

interface City {
  city: string;
  station_count: number;
  alert_default?: Record<string, { threshold: number } | undefined>;
  stations: { monitor_id: string; name: string; latitude: number; longitude: number }[];
}

export default function SettingsScreen() {
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [cities, setCities] = useState<City[] | null>(null);
  const [editing, setEditing] = useState<null | "place">(null);
  const [cityName, setCityName] = useState<string | null>(null);
  const [picked, setPicked] = useState<import("@/components/LocationPicker").PickedPlace | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    const p = loadPrefs();
    setPrefs(p);
    setCityName(p?.city ?? null);
    fetch("/api/locations")
      .then((r) => r.json())
      .then((b) => setCities(b.data ?? []))
      .catch(() => setCities([]));
  }, []);

  const city = useMemo(
    () => cities?.find((c) => c.city === cityName) ?? null,
    [cities, cityName],
  );

  const centre = useMemo(() => {
    if (!city?.stations?.length) return null;
    const n = city.stations.length;
    return {
      latitude: city.stations.reduce((t, s) => t + s.latitude, 0) / n,
      longitude: city.stations.reduce((t, s) => t + s.longitude, 0) / n,
    };
  }, [city]);

  /** Write one field and confirm it, so a change never looks like it was lost. */
  function update(patch: Partial<Omit<Prefs, "version" | "saved_at">>, note: string) {
    if (!prefs) return;
    const next = { ...prefs, ...patch };
    savePrefs({
      city: next.city,
      anchor: next.anchor,
      measurement: next.measurement,
      threshold: next.threshold,
    });
    setPrefs(loadPrefs());
    setSaved(note);
    window.setTimeout(() => setSaved(null), 2000);
  }

  if (!prefs) {
    return (
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="mt-4 text-gray-600">
          Nothing is set up yet.{" "}
          <Link href="/setup" className="text-blue-700 underline">
            Answer three questions
          </Link>{" "}
          and {APP_NAME} will know what to show you.
        </p>
      </div>
    );
  }

  const suggested = city?.alert_default?.[prefs.measurement]?.threshold ?? null;

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold tracking-tight">{APP_NAME}</h1>

      {saved && (
        <p className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-900">{saved}</p>
      )}

      {/* ── Location ──────────────────────────────────────────────────────── */}
      <section className="rounded-xl border border-gray-200 bg-white p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
              Location
            </h2>
            <p className="mt-1 font-medium">{prefs.anchor.name}</p>
            <p className="text-sm text-gray-600">
              {prefs.city} · averaged over the {NEAREST_K} nearest stations
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setEditing(editing === "place" ? null : "place");
              setPicked(null);
            }}
            className="shrink-0 text-sm font-medium text-blue-700 underline"
          >
            {editing === "place" ? "Cancel" : "Change"}
          </button>
        </div>

        {editing === "place" && (
          <div className="mt-4 space-y-3 border-t border-gray-100 pt-4">
            <label htmlFor="city" className="block text-sm font-medium text-gray-700">
              City
            </label>
            <select
              id="city"
              value={cityName ?? ""}
              onChange={(e) => {
                setCityName(e.target.value || null);
                setPicked(null);
              }}
              className="w-full rounded-md border border-gray-300 bg-white px-3 py-2"
            >
              <option value="">Choose a city…</option>
              {(cities ?? []).map((c) => (
                <option key={c.city} value={c.city}>
                  {c.city} ({c.station_count} stations)
                </option>
              ))}
            </select>

            {city && centre && (
              <LocationPicker
                centre={centre}
                city={city.city}
                value={picked}
                onChange={setPicked}
              />
            )}

            <button
              type="button"
              disabled={!picked || !city}
              onClick={() => {
                if (!picked || !city) return;
                update(
                  {
                    city: city.city,
                    anchor: {
                      monitor_id: picked.stations[0]?.monitor_id ?? "",
                      name: picked.label,
                      latitude: picked.latitude,
                      longitude: picked.longitude,
                    },
                  },
                  "Location saved.",
                );
                setEditing(null);
              }}
              className="w-full rounded-lg bg-blue-600 px-4 py-2.5 font-medium text-white disabled:opacity-40"
            >
              Save this place
            </button>
          </div>
        )}
      </section>

      {/* ── Pollutant ─────────────────────────────────────────────────────── */}
      <section className="rounded-xl border border-gray-200 bg-white p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
          Preferred measure
        </h2>
        <div className="mt-3 space-y-2">
          {(Object.keys(MEASUREMENT_COPY) as Measurement[]).map((key) => {
            const copy = MEASUREMENT_COPY[key];
            const on = prefs.measurement === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => update({ measurement: key }, `Now showing ${copy.short}.`)}
                className={`w-full rounded-lg border p-3 text-left ${
                  on ? "border-blue-600 bg-blue-50 ring-1 ring-blue-600" : "border-gray-300"
                }`}
              >
                <span className="block font-medium">{copy.label}</span>
                <span className="mt-1 block text-sm text-gray-600">{copy.blurb}</span>
              </button>
            );
          })}
        </div>
        <p className="mt-3 text-xs text-gray-500">
          <Link href="/learn/aqi-vs-pm25" className="underline">
            What is the difference?
          </Link>
        </p>
      </section>

      {/* ── Threshold ─────────────────────────────────────────────────────── */}
      <section className="rounded-xl border border-gray-200 bg-white p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
          Notification threshold
        </h2>

        <div className="mt-3 space-y-2">
          <button
            type="button"
            onClick={() =>
              update(
                { threshold: prefs.threshold ?? suggested ?? 100 },
                "You will be told on bad days.",
              )
            }
            className={`w-full rounded-lg border p-3 text-left ${
              prefs.threshold !== null
                ? "border-blue-600 bg-blue-50 ring-1 ring-blue-600"
                : "border-gray-300"
            }`}
          >
            <span className="block font-medium">
              Tell me when {MEASUREMENT_COPY[prefs.measurement].short} is{" "}
              {prefs.threshold ?? suggested ?? 100} or above
            </span>
          </button>

          {prefs.threshold !== null && (
            <div className="flex items-center gap-2 px-1">
              <input
                type="number"
                min={1}
                max={500}
                value={prefs.threshold}
                onChange={(e) => {
                  const v = e.target.value === "" ? null : Number(e.target.value);
                  if (v !== null && Number.isFinite(v)) update({ threshold: v }, "Threshold saved.");
                }}
                className="w-28 rounded-md border border-gray-300 px-3 py-2"
              />
              <span className="text-sm text-gray-600">
                {MEASUREMENT_COPY[prefs.measurement].short}
                {MEASUREMENT_COPY[prefs.measurement].unit
                  ? ` ${MEASUREMENT_COPY[prefs.measurement].unit}`
                  : ""}{" "}
                or above
              </span>
            </div>
          )}

          <button
            type="button"
            onClick={() => update({ threshold: null }, "You will not be notified.")}
            className={`w-full rounded-lg border p-3 text-left ${
              prefs.threshold === null
                ? "border-blue-600 bg-blue-50 ring-1 ring-blue-600"
                : "border-gray-300"
            }`}
          >
            <span className="block font-medium">Do not notify me</span>
          </button>
        </div>

        <p className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">
          Note: notifications are not enabled in the beta version of the app. This saves your
          preferences, so that they are in place when we update the app to send notifications.
        </p>
      </section>

      {/* ── Beyond the three answers ──────────────────────────────────────── */}
      <section className="rounded-xl border border-gray-200 bg-white p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
          About the data
        </h2>
        <ul className="mt-3 space-y-3 text-sm">
          <li>
            <Link href="/learn/aqi-vs-pm25" className="font-medium text-blue-700 underline">
              Where these numbers come from
            </Link>
            <p className="text-gray-600">
              What AQI measures, how it differs from PM2.5, and the limits of the data.
            </p>
          </li>
          <li>
            {/* THE PETITION HAD NO LINK LEFT. It used to sit in the data-age box
                on the home screen, which the 7 Oct review removed — so the page
                existed with nothing pointing at it. */}
            <Link href="/petition" className="font-medium text-blue-700 underline">
              Back hyperlocal measurement
            </Link>
            <p className="text-gray-600">
              A few dozen government monitors cover each city. Add your name to the case for
              measuring street by street.
            </p>
          </li>
          <li>
            <CityRequestForm />
            <p className="text-gray-600">
              We cover seven cities. Fifty requests for anywhere else in India and we add it.
            </p>
          </li>
        </ul>
      </section>

      <section className="px-1">
        <button
          type="button"
          onClick={() => {
            // Confirmed, because there is no account and nothing to restore it
            // from: this is the one irreversible button in the app.
            if (!window.confirm("Forget your place, measure and threshold on this device?")) return;
            clearPrefs();
            window.location.href = "/setup";
          }}
          className="text-sm text-red-700 underline"
        >
          Reset everything
        </button>
        <p className="mt-1 text-xs text-gray-500">
          Your answers are kept on this device only. Clearing your browser data loses them.
        </p>
      </section>
    </div>
  );
}
