"use client";

/**
 * What someone sees when they open the app.
 *
 * ORDER IS THE DESIGN, and it changed after the 7 Oct review. Top to bottom:
 * the app's name, the question box, today's number with the place it is for,
 * the forecast, and a map. Everything else that used to be here — a threshold
 * banner, the last measured reading, the list of contributing stations, and a
 * box explaining the data's age — has gone.
 *
 * WHY THOSE WENT. Each was defensible alone and together they buried the
 * number. The threshold warning is now the "Tomorrow" line turning red, which
 * says the same thing in the place the eye already is. The station list is one
 * line and an info button. The staleness explanation lives on the data-quality
 * route and the petition page rather than on the screen someone opens to check
 * one number.
 *
 * A client component because the user's place lives in localStorage; there is
 * no account to read it from on the server.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import dynamic from "next/dynamic";
import { loadPrefs, placeQuery, MEASUREMENT_COPY, NEAREST_K, type Prefs } from "@/lib/prefs";
import { APP_NAME } from "@/lib/brand";
import ForecastChart, { type ForecastDayInput } from "@/components/ForecastChart";
import InstallHint from "@/components/InstallHint";

const HomeMap = dynamic(() => import("@/components/StationMap"), {
  ssr: false,
  loading: () => <div className="h-56 w-full animate-pulse rounded-lg bg-gray-100" />,
});

interface Band {
  label: string;
  color: string;
  textColor: string;
}
interface Day {
  target_date: string;
  horizon_days: number;
  value: number;
  band_low: number | null;
  band_high: number | null;
  mode: string;
  band: Band;
  hourly: { hour: number; value: number; band_low: number | null; band_high: number | null }[] | null;
}
interface StationRef {
  monitor_id: string;
  name: string;
  distance_km: number;
}

/** "Today", "Thu", "Fri" — the axis labels in the mockup. */
function dayLabel(iso: string, today: string): string {
  if (iso === today) return "Today";
  const d = new Date(`${iso}T12:00:00+05:30`);
  return d.toLocaleDateString("en-IN", { weekday: "short" });
}

/** "a little worse, around 160" — plain words before the number. */
function describeChange(todayValue: number | null, tomorrowValue: number): string {
  if (todayValue === null) return `around ${Math.round(tomorrowValue)}`;
  const diff = tomorrowValue - todayValue;
  const rel = Math.abs(diff) / Math.max(todayValue, 1);
  const word =
    rel < 0.05 ? "about the same" : diff > 0 ? "a little worse" : "a little better";
  const strong = rel >= 0.25 ? (diff > 0 ? "worse" : "better") : word;
  return `${strong}, around ${Math.round(tomorrowValue)}`;
}

/** The run of hours with the lowest values — "2–4 pm" in the mockup. */
function cleanestWindow(hours: { hour: number; value: number }[] | null): string | null {
  if (!hours || hours.length < 6) return null;
  // Daytime only: the small hours are usually cleanest and advising someone to
  // go out at 4am is useless even when it is true.
  const day = hours.filter((h) => h.hour >= 6 && h.hour <= 21);
  if (day.length < 4) return null;
  let best = { start: day[0].hour, mean: Infinity };
  for (let i = 0; i + 2 < day.length; i++) {
    const mean = (day[i].value + day[i + 1].value + day[i + 2].value) / 3;
    if (mean < best.mean) best = { start: day[i].hour, mean };
  }
  const fmt = (h: number) => {
    const suffix = h < 12 ? "am" : "pm";
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}${suffix}`;
  };
  return `${fmt(best.start)}–${fmt(best.start + 3)}`;
}

export default function HomeScreen() {
  const router = useRouter();
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [days, setDays] = useState<Day[] | null>(null);
  const [todayIso, setTodayIso] = useState<string>("");
  const [stations, setStations] = useState<StationRef[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showStations, setShowStations] = useState(false);

  useEffect(() => {
    const p = loadPrefs();
    if (!p) {
      router.replace("/setup");
      return;
    }
    setPrefs(p);

    const q = placeQuery(p, {
      pollutant: p.measurement,
      days: 5,
      hourly: "true",
      include_today: "true",
    });
    fetch(`/api/forecast?${q}`)
      .then((r) => r.json())
      .then((b) => {
        if (b?.error) {
          setError(b.error.message);
          return;
        }
        setDays(b.data.days ?? []);
        setTodayIso(b.data.today ?? "");
        setStations(b.meta?.stations ?? []);
      })
      .catch(() => setError("Could not reach the server."));
  }, [router]);

  if (!prefs) return <p className="text-gray-500">Loading…</p>;

  const unit = MEASUREMENT_COPY[prefs.measurement].unit;
  const short = MEASUREMENT_COPY[prefs.measurement].short;

  const today = days?.find((d) => d.target_date === todayIso) ?? days?.[0] ?? null;
  const tomorrow = days?.find((d) => d.target_date !== (today?.target_date ?? "")) ?? null;
  const overThreshold =
    prefs.threshold !== null && tomorrow !== null && tomorrow.value >= prefs.threshold;

  const points: ForecastDayInput[] = (days ?? []).map((d) => ({
    target_date: d.target_date,
    value: d.value,
    band_low: d.band_low,
    band_high: d.band_high,
    mode: d.mode,
    hourly: d.hourly,
    label: dayLabel(d.target_date, todayIso),
  }));

  const cleanest = cleanestWindow(today?.hourly ?? null);

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold tracking-tight">{APP_NAME}</h1>

      {/* The question box leads, because it is the thing this app does that
          nothing else does. */}
      <Link
        href="/ask"
        className="block rounded-xl border border-gray-200 bg-white p-5 text-center shadow-sm transition hover:bg-gray-50"
      >
        <span className="block text-lg font-semibold">Ask AI: When should I go out?</span>
        <span className="mt-1 block text-sm text-gray-500">
          Suggestions based on {short} data
        </span>
      </Link>

      {error && (
        <p className="rounded-md bg-red-50 px-4 py-3 text-sm text-red-800">{error}</p>
      )}

      {/* Expected today. */}
      {today && (
        <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <div className="flex items-start gap-4">
            <div
              className="flex h-24 w-24 shrink-0 flex-col items-center justify-center rounded-xl"
              style={{ backgroundColor: today.band.color, color: today.band.textColor }}
            >
              <span className="text-3xl font-bold leading-none">
                {Math.round(today.value)}
              </span>
              <span className="mt-1 text-[10px] font-semibold uppercase tracking-wide">
                {today.band.label}
              </span>
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="font-semibold">Expected today</h2>
              <p className="mt-1 text-sm text-gray-600">
                {short}
                {unit ? ` (${unit})` : ""}, average forecast from {stations.length || NEAREST_K}{" "}
                nearest monitoring stations{" "}
                <button
                  type="button"
                  onClick={() => setShowStations((v) => !v)}
                  aria-label="Which stations?"
                  className="ml-0.5 inline-flex h-4 w-4 items-center justify-center rounded-full border border-gray-400 text-[10px] font-semibold text-gray-600 align-middle"
                >
                  i
                </button>
              </p>

              {showStations && (
                <ul className="mt-2 space-y-1 border-t border-gray-100 pt-2 text-xs text-gray-600">
                  {stations.length === 0 && <li>Station list unavailable.</li>}
                  {stations.map((s) => (
                    <li key={s.monitor_id} className="flex justify-between gap-3">
                      <span className="truncate">{s.name}</span>
                      <span className="shrink-0 tabular-nums">
                        {s.distance_km.toFixed(1)} km
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              {/* The place, not the city — the point they dropped in setup. */}
              <Link
                href="/settings"
                className="mt-3 inline-flex items-center gap-1 border-t border-gray-100 pt-3 text-sm font-medium text-gray-900"
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 21s-7-5.2-7-11a7 7 0 1 1 14 0c0 5.8-7 11-7 11z" />
                  <circle cx="12" cy="10" r="2.5" />
                </svg>
                {prefs.anchor.name}
                <svg viewBox="0 0 24 24" className="h-4 w-4 text-gray-500" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </Link>
            </div>
          </div>
        </section>
      )}

      {/* Forecast. */}
      {points.length >= 2 && (
        <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wide">Forecast</h2>
            <span className="text-xs text-gray-500">
              {short}
              {unit ? ` · ${unit}` : ""}
            </span>
          </div>
          <div className="mt-2">
            <ForecastChart days={points} unit={unit} />
          </div>

          {tomorrow && (
            <p
              className={`mt-4 border-t border-gray-100 pt-3 text-sm ${
                overThreshold ? "font-semibold text-red-700" : "text-gray-900"
              }`}
            >
              <span className="font-semibold">Tomorrow:</span>{" "}
              {describeChange(today?.value ?? null, tomorrow.value)}
              {overThreshold && (
                <>
                  {" "}
                  — above your {prefs.threshold} {short} threshold
                </>
              )}
              .
            </p>
          )}
          {cleanest && (
            <p className="mt-1 text-sm text-gray-600">
              Cleanest hours today: <span className="font-medium text-gray-900">{cleanest}</span>
            </p>
          )}
        </section>
      )}

      <section className="overflow-hidden rounded-xl border border-gray-200">
        <HomeMap heightClass="h-56" />
      </section>

      <InstallHint />
    </div>
  );
}
