"use client";

/**
 * What someone sees when they open the app.
 *
 * Order is deliberate. The FORECAST leads, not the current reading, because
 * OpenAQ runs days behind for India's government monitors — "what will it be
 * like tomorrow" is answerable, "what is it right now" usually is not. The
 * latest measurement comes second, with its age attached.
 *
 * A client component because the user's place lives in localStorage; there is
 * no account to read it from on the server.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { loadPrefs, placeQuery, MEASUREMENT_COPY, type Prefs } from "@/lib/prefs";

interface Band {
  label: string;
  color: string;
  textColor: string;
}
interface StationRef {
  monitor_id: string;
  name: string;
  distance_km: number;
}
interface DataQuality {
  level: string;
  headline: string;
  explanation: string;
  affects_forecast: boolean;
  actions: { id: string; label: string; body: string; available: boolean }[];
}
interface ForecastDay {
  target_date: string;
  value: number;
  band: Band;
  mode: string;
  headline: string;
  band_low: number | null;
  band_high: number | null;
}
interface ForecastBody {
  data: {
    tomorrow: ForecastDay | null;
    best_hour: { hour: number; local_time: string; value: number } | null;
    data_quality: DataQuality;
  };
  meta: { stations: StationRef[]; furthest_km: number };
}
interface CurrentBody {
  data: {
    aqi: number;
    band: Band;
    dominant_pollutant: string;
    recorded_clock: string;
    age_hours: number;
    stale: boolean;
    pollutants: { pollutant: string; value: number }[];
  };
}

export default function HomeScreen() {
  const router = useRouter();
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [forecast, setForecast] = useState<ForecastBody | null>(null);
  const [current, setCurrent] = useState<CurrentBody | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const p = loadPrefs();
    if (!p) {
      router.replace("/setup");
      return;
    }
    setPrefs(p);

    const q = placeQuery(p, { pollutant: p.measurement, days: 1, hourly: "true" });
    Promise.all([
      fetch(`/api/forecast?${q}`).then((r) => r.json()),
      fetch(`/api/current?${placeQuery(p)}`).then((r) => r.json()),
    ])
      .then(([f, c]) => {
        if (f?.error) setError(f.error.message);
        else setForecast(f);
        if (!c?.error) setCurrent(c);
      })
      .catch(() => setError("Could not reach the server."));
  }, [router]);

  if (!prefs) return <p className="text-gray-500">Loading…</p>;

  const unit = MEASUREMENT_COPY[prefs.measurement].unit;
  const short = MEASUREMENT_COPY[prefs.measurement].short;
  const tomorrow = forecast?.data.tomorrow ?? null;
  const quality = forecast?.data.data_quality ?? null;
  const stations = forecast?.meta.stations ?? [];

  return (
    <div className="space-y-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{prefs.city}</h1>
          <p className="text-sm text-gray-600">near {prefs.anchor.name}</p>
        </div>
        <Link href="/setup" className="text-sm text-blue-700 underline">
          Change
        </Link>
      </header>

      {error && (
        <p className="rounded-md bg-red-50 px-4 py-3 text-sm text-red-800">{error}</p>
      )}

      {/* The forecast leads. */}
      {tomorrow && (
        <section
          className="rounded-xl p-6"
          style={{ backgroundColor: tomorrow.band.color, color: tomorrow.band.textColor }}
        >
          {/* No opacity on text sitting on a band colour. "Very Poor" is red
              on white at 4.0:1, already under the 4.5:1 standard for normal
              text, and dimming it would push it further — on exactly the band
              Delhi sits in all winter. Everything here is either large or
              bold, which is the threshold that applies instead (3:1). */}
          <p className="text-sm font-semibold">{tomorrow.headline}</p>
          <p className="mt-2 text-6xl font-bold tabular-nums">
            {Math.round(tomorrow.value)}
            {unit && <span className="ml-2 text-2xl font-medium">{unit}</span>}
          </p>
          <p className="mt-1 text-lg font-semibold">
            {tomorrow.band.label}
            <span className="ml-2 text-sm font-semibold">{short}</span>
          </p>
          {tomorrow.band_low !== null && tomorrow.band_high !== null && (
            <p className="mt-2 text-sm font-semibold">
              likely between {Math.round(tomorrow.band_low)} and {Math.round(tomorrow.band_high)}
            </p>
          )}
        </section>
      )}

      {forecast?.data.best_hour && tomorrow?.mode !== "seasonal_normal" && (
        <p className="text-sm text-gray-700">
          Cleanest around{" "}
          <span className="font-medium">
            {forecast.data.best_hour.local_time.slice(11, 16)}
          </span>{" "}
          tomorrow.
        </p>
      )}

      {/* The latest measurement, with its age attached. */}
      {current && (
        <section className="rounded-lg border border-gray-200 bg-white p-4">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-medium text-gray-700">Last measured</h2>
            <span className="text-xs text-gray-500">
              {current.data.recorded_clock}
              {current.data.age_hours >= 24
                ? `, ${Math.round(current.data.age_hours / 24)} days ago`
                : `, ${Math.round(current.data.age_hours)}h ago`}
            </span>
          </div>
          <p className="mt-1 text-3xl font-semibold tabular-nums">
            {current.data.aqi}
            <span className="ml-2 text-base font-normal text-gray-600">
              {current.data.band.label}
            </span>
          </p>
          <p className="mt-1 text-xs text-gray-500">
            Driven by {current.data.dominant_pollutant.toUpperCase()}
          </p>
        </section>
      )}

      {/* Which stations this is actually built from. */}
      {stations.length > 0 && (
        <section className="rounded-lg border border-gray-200 bg-white p-4">
          <h2 className="text-sm font-medium text-gray-700">
            Averaged from {stations.length} nearby{" "}
            {stations.length === 1 ? "station" : "stations"}
          </h2>
          <ul className="mt-2 space-y-1 text-sm text-gray-600">
            {stations.map((s) => (
              <li key={s.monitor_id} className="flex justify-between gap-4">
                <span className="truncate">{s.name}</span>
                <span className="shrink-0 tabular-nums text-gray-500">
                  {s.distance_km} km
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Staleness, and what to do about it. */}
      {quality && quality.actions.length > 0 && (
        <section className="rounded-lg border border-amber-300 bg-amber-50 p-4">
          <h2 className="font-medium text-amber-900">{quality.headline}</h2>
          <p className="mt-1 text-sm text-amber-900/90">{quality.explanation}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {quality.actions.map((a) =>
              a.id === "support_hyperlocal" ? (
                <Link
                  key={a.id}
                  href="/petition"
                  className="rounded-md bg-amber-900 px-3 py-2 text-sm font-medium text-white hover:bg-amber-800"
                >
                  {a.label}
                </Link>
              ) : (
                <span
                  key={a.id}
                  title={a.body}
                  className="rounded-md border border-amber-400 px-3 py-2 text-sm text-amber-900"
                >
                  {a.label} <span className="opacity-70">(coming in v2)</span>
                </span>
              ),
            )}
          </div>
        </section>
      )}

      {/* The handoff to the question box. */}
      <section className="rounded-lg border border-gray-200 bg-white p-4">
        <h2 className="font-medium">Ask about the air</h2>
        <p className="mt-1 text-sm text-gray-600">
          Plain questions, answered from the same data — try one.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {[
            `Is tomorrow worse than today in ${prefs.city}?`,
            "When is the cleanest time to go out tomorrow?",
            `How was last week in ${prefs.city}?`,
          ].map((q) => (
            <Link
              key={q}
              href={`/ask?q=${encodeURIComponent(q)}`}
              className="rounded-full border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50"
            >
              {q}
            </Link>
          ))}
        </div>
        <Link
          href="/ask"
          className="mt-3 inline-block rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          Ask your own question
        </Link>
      </section>
    </div>
  );
}
