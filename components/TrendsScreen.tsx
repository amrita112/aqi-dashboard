"use client";

/**
 * Trends: the forecast ahead and the measured past, for one or two places.
 *
 * REBUILT FROM THE 7 OCT REVIEW. What changed and why:
 *
 * TWO PLACES. The point of a trends screen is comparison, and comparing your
 * own neighbourhood against somewhere else is the comparison people actually
 * want. Either slot can be changed; the second can be removed.
 *
 * NEAREST STATIONS, NOT THE CITY AVERAGE. placeQuery sends lat/lng with k=3, so
 * "my place" has always meant the three nearest stations. A city picked for the
 * second slot is that city's average, which is a different thing and is
 * labelled as such.
 *
 * NO 90-DAY OR 1-YEAR HISTORY. Supabase holds about six weeks. Offering "1y"
 * and returning 42 days is a false promise, so the options are 7 and 30 days
 * until there is more behind them.
 *
 * NO "IST" ANYWHERE. Every time in this app is Indian time; saying so on every
 * axis label is noise.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  loadPrefs,
  MEASUREMENT_COPY,
  NEAREST_K,
  type Measurement,
  type Prefs,
} from "@/lib/prefs";
import { APP_NAME } from "@/lib/brand";
import TrendsChart, { SERIES_COLORS, type Series, type SeriesPoint } from "@/components/TrendsChart";

type ForecastRange = "next24" | "days3" | "days7";
type HistoryRange = 7 | 30;

const FORECAST_LABEL: Record<ForecastRange, string> = {
  next24: "Next 24 hours",
  days3: "3 days",
  days7: "7 days",
};

interface Place {
  key: string;
  label: string;
  /** Query fragment: a point for "my place", a city name otherwise. */
  query: Record<string, string>;
}

interface Day {
  target_date: string;
  value: number;
  band_low: number | null;
  band_high: number | null;
  mode: string;
  hourly: { hour: number; value: number; band_low: number | null; band_high: number | null }[] | null;
}

interface HistoryRow {
  date: string;
  mean: number | null;
  min: number | null;
  max: number | null;
}

/** "9 Oct" */
function humanDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${Number(m[3])} ${months[Number(m[2]) - 1]}`;
}

function clock(hour: number): string {
  const s = hour < 12 ? "am" : "pm";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}${s}`;
}

/** How many stations make up a "city" here, against three for a doorstep. */
const CITY_K = 10;
const CITY_MAX_KM = 60;

function cityQuery(c: { city: string; lat: number; lng: number }): Record<string, string> {
  return {
    lat: String(c.lat),
    lng: String(c.lng),
    k: String(CITY_K),
    max_km: String(CITY_MAX_KM),
    city: c.city,
  };
}

/** The current hour in India, wherever the device is. */
function istHourNow(): number {
  return new Date(Date.now() + (5 * 60 + 30) * 60_000).getUTCHours();
}

export default function TrendsScreen() {
  const router = useRouter();
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [cities, setCities] = useState<{ city: string; lat: number; lng: number }[]>([]);
  const [measurement, setMeasurement] = useState<Measurement>("aqi");
  const [places, setPlaces] = useState<Place[]>([]);
  const [fRange, setFRange] = useState<ForecastRange>("days3");
  const [hRange, setHRange] = useState<HistoryRange>(30);
  const [forecasts, setForecasts] = useState<Record<string, Day[] | null>>({});
  const [histories, setHistories] = useState<Record<string, HistoryRow[] | null>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const p = loadPrefs();
    if (!p) {
      router.replace("/setup");
      return;
    }
    setPrefs(p);
    setMeasurement(p.measurement);
    setPlaces([
      {
        key: "mine",
        label: p.anchor.name,
        query: { lat: String(p.anchor.latitude), lng: String(p.anchor.longitude), k: String(NEAREST_K) },
      },
    ]);
    // City centres are the mean of that city's own stations, so a city cannot
    // drift from a hardcoded coordinate when stations are added or removed.
    fetch("/api/locations")
      .then((r) => r.json())
      .then((b) =>
        setCities(
          (b.data ?? [])
            .filter((c: { stations?: unknown[] }) => c.stations?.length)
            .map((c: { city: string; stations: { latitude: number; longitude: number }[] }) => ({
              city: c.city,
              lat: c.stations.reduce((t, x) => t + x.latitude, 0) / c.stations.length,
              lng: c.stations.reduce((t, x) => t + x.longitude, 0) / c.stations.length,
            })),
        ),
      )
      .catch(() => {});
  }, [router]);

  const load = useCallback(
    async (place: Place) => {
      const base = new URLSearchParams({ ...place.query, pollutant: measurement });
      const fDays = fRange === "days7" ? 7 : fRange === "days3" ? 3 : 2;
      const f = new URLSearchParams(base);
      f.set("days", String(fDays));
      f.set("hourly", "true");
      f.set("include_today", "true");
      const h = new URLSearchParams(base);
      h.set("days", String(hRange));

      const [fr, hr] = await Promise.all([
        fetch(`/api/forecast?${f}`).then((r) => r.json()).catch(() => null),
        fetch(`/api/history?${h}`).then((r) => r.json()).catch(() => null),
      ]);
      setForecasts((prev) => ({ ...prev, [place.key]: fr?.error ? [] : (fr?.data?.days ?? []) }));
      setHistories((prev) => ({
        ...prev,
        [place.key]: hr?.error ? [] : (Array.isArray(hr?.data) ? hr.data : []),
      }));
      if (fr?.error && hr?.error) setError(fr.error.message);
    },
    [measurement, fRange, hRange],
  );

  useEffect(() => {
    if (!places.length) return;
    setForecasts({});
    setHistories({});
    setError(null);
    void Promise.all(places.map(load));
  }, [places, load]);

  const unit = MEASUREMENT_COPY[measurement].unit;

  // ── Forecast series ───────────────────────────────────────────────────────
  const forecastSeries: Series[] = useMemo(() => {
    const nowHour = istHourNow();
    return places.map((pl, idx) => {
      const days = forecasts[pl.key] ?? [];
      const points: SeriesPoint[] = [];

      if (fRange === "next24") {
        // Genuinely the next 24 hours from now, not a calendar day: spans the
        // midnight boundary, which "today's forecast" would not.
        let taken = 0;
        days.forEach((d, di) => {
          (d.hourly ?? []).forEach((h) => {
            if (di === 0 && h.hour < nowHour) return;
            if (taken >= 24) return;
            taken += 1;
            points.push({
              label: h.hour % 6 === 0 ? clock(h.hour) : "",
              full: `${humanDate(d.target_date)}, ${clock(h.hour)}`,
              value: h.value,
              low: h.band_low,
              high: h.band_high,
            });
          });
        });
      } else {
        days.forEach((d) => {
          const hours = d.hourly ?? [];
          if (hours.length === 24) {
            hours.forEach((h) => {
              points.push({
                label: h.hour === 12 ? humanDate(d.target_date) : "",
                full: `${humanDate(d.target_date)}, ${clock(h.hour)}`,
                value: h.value,
                low: h.band_low,
                high: h.band_high,
              });
            });
          } else {
            points.push({
              label: humanDate(d.target_date),
              full: humanDate(d.target_date),
              value: d.value,
              low: d.band_low,
              high: d.band_high,
            });
          }
        });
      }
      return { key: pl.key, label: pl.label, color: SERIES_COLORS[idx] ?? "#5c6b73", points };
    });
  }, [places, forecasts, fRange]);

  // ── History series ────────────────────────────────────────────────────────
  const historySeries: Series[] = useMemo(
    () =>
      places.map((pl, idx) => {
        const rows = histories[pl.key] ?? [];
        return {
          key: pl.key,
          label: pl.label,
          color: SERIES_COLORS[idx] ?? "#5c6b73",
          points: rows.map((r) => ({
            label: humanDate(r.date),
            full: humanDate(r.date),
            value: r.mean,
            low: r.min,
            high: r.max,
          })),
        };
      }),
    [places, histories],
  );

  const forecastDates = useMemo(() => {
    const days = forecasts[places[0]?.key ?? ""] ?? [];
    if (!days.length) return null;
    return days.length === 1
      ? humanDate(days[0].target_date)
      : `${humanDate(days[0].target_date)} – ${humanDate(days[days.length - 1].target_date)}`;
  }, [forecasts, places]);

  function setPlaceAt(idx: number, city: string) {
    setPlaces((prev) => {
      const next = [...prev];
      if (city === "__mine" && prefs) {
        next[idx] = {
          key: `mine`,
          label: prefs.anchor.name,
          query: {
            lat: String(prefs.anchor.latitude),
            lng: String(prefs.anchor.longitude),
            k: String(NEAREST_K),
          },
        };
      } else {
        const c = cities.find((x) => x.city === city);
        if (!c) return prev;
        // /api/history and /api/forecast take a POINT, not a city name, so a
        // city is its centre with a wide net: ten stations inside that city
        // rather than the three nearest a doorstep.
        next[idx] = { key: `city:${city}`, label: city, query: cityQuery(c) };
      }
      return next;
    });
  }

  if (!prefs) return <p className="text-gray-500">Loading…</p>;

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold tracking-tight">{APP_NAME}</h1>

      {/* Places and pollutant, as controls rather than a header and a Change
          link: every one of them is something to change, not something to read. */}
      <div className="flex flex-wrap items-center gap-2">
        {places.map((pl, idx) => (
          <span key={`${pl.key}-${idx}`} className="inline-flex items-center">
            <span
              className="mr-1.5 inline-block h-2.5 w-2.5 rounded-full"
              style={{ background: SERIES_COLORS[idx] ?? "#5c6b73" }}
            />
            <select
              value={pl.key === "mine" ? "__mine" : pl.label}
              onChange={(e) => setPlaceAt(idx, e.target.value)}
              aria-label={`Place ${idx + 1}`}
              className="rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-sm font-medium"
            >
              <option value="__mine">{prefs.anchor.name} (my place)</option>
              {cities.map((c) => (
                <option key={c.city} value={c.city}>
                  {c.city}
                </option>
              ))}
            </select>
            {idx === 1 && (
              <button
                type="button"
                onClick={() => setPlaces((prev) => prev.slice(0, 1))}
                aria-label="Remove second place"
                className="ml-1 text-gray-400 hover:text-gray-700"
              >
                ×
              </button>
            )}
          </span>
        ))}

        {places.length === 1 && cities.length > 0 && (
          <button
            type="button"
            onClick={() =>
              setPlaces((prev) => [
                ...prev,
                {
                  key: `city:${cities[0].city}`,
                  label: cities[0].city,
                  query: cityQuery(cities[0]),
                },
              ])
            }
            className="rounded-lg border border-dashed border-gray-400 px-2.5 py-1.5 text-sm text-gray-700"
          >
            + Compare
          </button>
        )}

        <select
          value={measurement}
          onChange={(e) => setMeasurement(e.target.value as Measurement)}
          aria-label="Which pollutant"
          className="ml-auto rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-sm font-medium"
        >
          <option value="aqi">{MEASUREMENT_COPY.aqi.short}</option>
          <option value="pm25">{MEASUREMENT_COPY.pm25.short}</option>
        </select>
      </div>

      {error && <p className="rounded-md bg-red-50 px-4 py-3 text-sm text-red-800">{error}</p>}

      {/* ── Forecast ───────────────────────────────────────────────────────── */}
      <section className="rounded-xl border border-gray-200 bg-white p-4">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="font-semibold">Forecast</h2>
          <select
            value={fRange}
            onChange={(e) => setFRange(e.target.value as ForecastRange)}
            aria-label="How far ahead"
            className="rounded-md border border-gray-300 bg-white px-2 py-1 text-xs"
          >
            {(Object.keys(FORECAST_LABEL) as ForecastRange[]).map((k) => (
              <option key={k} value={k}>
                {FORECAST_LABEL[k]}
              </option>
            ))}
          </select>
        </div>
        {/* The dates, stated. Someone should never have to trust that the app
            knows what day it is. */}
        {forecastDates && <p className="mt-0.5 text-xs text-gray-500">{forecastDates}</p>}
        <div className="mt-3">
          {forecastSeries.every((s) => !s.points.length) ? (
            <p className="py-10 text-center text-sm text-gray-500">Loading…</p>
          ) : (
            <TrendsChart
              series={forecastSeries}
              unit={unit}
              bandLabel="likely range"
              threshold={prefs.threshold}
            />
          )}
        </div>
      </section>

      {/* ── History ────────────────────────────────────────────────────────── */}
      <section className="rounded-xl border border-gray-200 bg-white p-4">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="font-semibold">History</h2>
          <select
            value={hRange}
            onChange={(e) => setHRange(Number(e.target.value) as HistoryRange)}
            aria-label="How far back"
            className="rounded-md border border-gray-300 bg-white px-2 py-1 text-xs"
          >
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
          </select>
        </div>
        <div className="mt-3">
          {historySeries.every((s) => !s.points.length) ? (
            <p className="py-10 text-center text-sm text-gray-500">
              No daily history held for this place in that window.
            </p>
          ) : (
            <TrendsChart
              series={historySeries}
              unit={unit}
              bandLabel="day's lowest to highest"
              threshold={prefs.threshold}
            />
          )}
        </div>
      </section>
    </div>
  );
}
