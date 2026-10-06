"use client";

/**
 * Two questions this screen answers that the home screen cannot.
 *
 *   WHEN tomorrow — the daily forecast spread across 24 IST hours using the
 *   diurnal shape. This is the only place that work becomes visible to a user,
 *   and it is what turns "tomorrow is bad" into "go out at nine, not nine at
 *   night".
 *
 *   WHETHER IT IS GETTING WORSE — the last month of daily values, with the
 *   day's range behind the mean.
 *
 * Both respect the measurement chosen at first run. Composite AQI history is
 * derived rather than stored (see getHistoryAqi), so this works for either.
 *
 * Two things are drawn rather than hidden, because a chart that smooths over
 * them tells a lie that looks like data:
 *
 *   - a day backed by fewer stations is marked, since coverage is uneven
 *   - an hourly curve with no fitted shape is flat, and says so instead of
 *     implying every hour is genuinely identical
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  ResponsiveContainer, AreaChart, Area, LineChart, Line,
  XAxis, YAxis, Tooltip, CartesianGrid, ReferenceLine,
} from "recharts";
import { loadPrefs, placeQuery, MEASUREMENT_COPY, type Prefs } from "@/lib/prefs";

interface HourPoint { hour: number; local_time: string; value: number }
interface DayPoint {
  date: string; mean: number; min: number; max: number;
  stations: number; completeness: number;
}

export default function TrendsScreen() {
  const router = useRouter();
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [hourly, setHourly] = useState<HourPoint[] | null>(null);
  const [flatHours, setFlatHours] = useState(false);
  const [daily, setDaily] = useState<DayPoint[] | null>(null);
  const [days, setDays] = useState(30);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const p = loadPrefs();
    if (!p) { router.replace("/setup"); return; }
    setPrefs(p);
  }, [router]);

  useEffect(() => {
    if (!prefs) return;
    let cancelled = false;

    fetch(`/api/forecast?${placeQuery(prefs, { pollutant: prefs.measurement, days: 1 })}`)
      .then((r) => r.json())
      .then((b) => {
        if (cancelled || b?.error) return;
        setHourly(b.data.tomorrow?.hourly ?? null);
        setFlatHours(Boolean(b.meta?.hourly_is_flat));
      })
      .catch(() => {});

    fetch(`/api/history?${placeQuery(prefs, { pollutant: prefs.measurement, days })}`)
      .then((r) => r.json())
      .then((b) => {
        if (cancelled) return;
        if (b?.error) setError(b.error.message);
        else setDaily(b.data as DayPoint[]);
      })
      .catch(() => !cancelled && setError("Could not reach the server."));

    return () => { cancelled = true; };
  }, [prefs, days]);

  if (!prefs) return <p className="text-gray-500">Loading…</p>;

  const copy = MEASUREMENT_COPY[prefs.measurement];
  const unit = copy.unit ? ` ${copy.unit}` : "";
  const threshold = prefs.threshold;

  return (
    <div className="space-y-8">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-gray-900">Trends</h1>
          <p className="text-sm text-gray-600">
            {prefs.city} · {copy.short}
          </p>
        </div>
        <Link href="/setup" className="text-sm text-blue-700 underline">Change</Link>
      </header>

      {error && <p className="rounded-md bg-red-50 px-4 py-3 text-sm text-red-800">{error}</p>}

      {/* ── Tomorrow, hour by hour ───────────────────────────────────────── */}
      <section>
        <h2 className="font-semibold text-gray-900">Tomorrow, hour by hour</h2>
        <p className="mt-1 text-sm text-gray-600">
          Times are IST. The shape comes from years of history for this city and month,
          scaled to tomorrow&apos;s forecast.
        </p>

        {flatHours ? (
          <p className="mt-3 rounded-md bg-gray-50 px-3 py-2 text-sm text-gray-700">
            No hourly pattern has been fitted for this city and month yet, so every hour
            would show the same number. Nothing useful to draw.
          </p>
        ) : hourly ? (
          <div className="mt-3 h-56 w-full">
            <ResponsiveContainer>
              <AreaChart data={hourly} margin={{ top: 5, right: 8, bottom: 0, left: -18 }}>
                <CartesianGrid stroke="#eee" vertical={false} />
                <XAxis
                  dataKey="hour" tickLine={false} axisLine={false}
                  ticks={[0, 6, 12, 18, 23]}
                  tickFormatter={(h: number) => `${String(h).padStart(2, "0")}:00`}
                  tick={{ fontSize: 11, fill: "#6b7280" }}
                />
                <YAxis tickLine={false} axisLine={false} width={44}
                       tick={{ fontSize: 11, fill: "#6b7280" }} />
                <Tooltip
                  formatter={(v) => [`${Math.round(Number(v))}${unit}`, copy.short]}
                  labelFormatter={(h) => `${String(h).padStart(2, "0")}:00 IST`}
                />
                {threshold !== null && (
                  <ReferenceLine y={threshold} stroke="#b3261e" strokeDasharray="4 3"
                                 label={{ value: "your limit", position: "insideTopRight",
                                          fontSize: 10, fill: "#b3261e" }} />
                )}
                <Area type="monotone" dataKey="value" stroke="#2a78d6"
                      strokeWidth={2} fill="#2a78d6" fillOpacity={0.12} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <p className="mt-3 text-sm text-gray-500">Loading…</p>
        )}

        {hourly && !flatHours && (() => {
          const best = hourly.reduce((a, b) => (b.value < a.value ? b : a));
          const worst = hourly.reduce((a, b) => (b.value > a.value ? b : a));
          return (
            <p className="mt-2 text-sm text-gray-700">
              Cleanest around <strong>{String(best.hour).padStart(2, "0")}:00</strong>,
              worst around <strong>{String(worst.hour).padStart(2, "0")}:00</strong> —
              a difference of {Math.round(worst.value - best.value)}{unit}.
            </p>
          );
        })()}
      </section>

      {/* ── The recent past ──────────────────────────────────────────────── */}
      <section>
        <div className="flex items-baseline justify-between">
          <h2 className="font-semibold text-gray-900">The last {days} days</h2>
          <div className="flex gap-1">
            {[30, 90, 365].map((d) => (
              <button
                key={d} type="button" onClick={() => { setDaily(null); setDays(d); }}
                className={`rounded-md px-2 py-1 text-xs ${
                  d === days ? "bg-gray-900 text-white" : "border border-gray-300 text-gray-700"
                }`}
              >
                {d === 365 ? "1y" : `${d}d`}
              </button>
            ))}
          </div>
        </div>

        {daily === null ? (
          <p className="mt-3 text-sm text-gray-500">Loading…</p>
        ) : daily.length === 0 ? (
          <p className="mt-3 text-sm text-gray-600">
            No daily history held for this place in that window.
          </p>
        ) : (
          <>
            <div className="mt-3 h-56 w-full">
              <ResponsiveContainer>
                <LineChart data={daily} margin={{ top: 5, right: 8, bottom: 0, left: -18 }}>
                  <CartesianGrid stroke="#eee" vertical={false} />
                  <XAxis
                    dataKey="date" tickLine={false} axisLine={false} minTickGap={28}
                    tickFormatter={(d: string) => d.slice(5)}
                    tick={{ fontSize: 11, fill: "#6b7280" }}
                  />
                  <YAxis tickLine={false} axisLine={false} width={44}
                         tick={{ fontSize: 11, fill: "#6b7280" }} />
                  <Tooltip
                    formatter={(v, name) => [`${Math.round(Number(v))}${unit}`, String(name)]}
                    labelFormatter={(d) => String(d)}
                  />
                  {threshold !== null && (
                    <ReferenceLine y={threshold} stroke="#b3261e" strokeDasharray="4 3" />
                  )}
                  {/* The day's range sits behind its mean, because a daily mean
                      alone hides that the worst hour was far worse. */}
                  <Line type="monotone" dataKey="max" stroke="#c8d6e5" strokeWidth={1}
                        dot={false} name="day's worst" />
                  <Line type="monotone" dataKey="min" stroke="#c8d6e5" strokeWidth={1}
                        dot={false} name="day's best" />
                  <Line type="monotone" dataKey="mean" stroke="#2a78d6" strokeWidth={2.2}
                        dot={false} name="daily average" />
                </LineChart>
              </ResponsiveContainer>
            </div>

            <Coverage daily={daily} />
          </>
        )}
      </section>
    </div>
  );
}

/**
 * How much of that window is actually backed by data.
 *
 * Shown because the chart cannot: a line drawn through days held up by one
 * station looks exactly like a line drawn through days held up by three.
 */
function Coverage({ daily }: { daily: DayPoint[] }) {
  const thin = daily.filter((d) => d.stations < 2).length;
  const avgStations = daily.reduce((s, d) => s + d.stations, 0) / daily.length;
  return (
    <p className="mt-2 text-xs text-gray-500">
      {daily.length} days with data, averaging {avgStations.toFixed(1)} stations each.
      {thin > 0 && ` ${thin} rest on a single station — treat those as a rough guide.`}
    </p>
  );
}
