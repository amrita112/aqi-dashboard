/**
 * GET /api/history-hourly?lat=&lng=&k=&pollutant=&days=      a point
 * GET /api/history-hourly?city=...[&lat=&lng=]&pollutant=&days=  a city average
 *
 * Measured values hour by hour, averaged across the nearby stations (or, for
 * a city average, every active station in the city) — the shape of the last
 * few days rather than one number per day.
 *
 * SEPARATE FROM /api/history BECAUSE IT READS A DIFFERENT TABLE. The daily
 * endpoint reads readings_daily, which is pre-aggregated and cheap. There is
 * no hourly rollup, so this goes to `readings` and `measurements` directly,
 * which is heavier and is why the window is capped hard.
 *
 * AQI IS NOT RECOMPUTED HERE. readings.aqi_value holds the composite the
 * ingest calculated at the time; for a single pollutant the value comes from
 * measurements. Both paths average across STATIONS within an hour and never
 * across hours, because mixing hours would invent a value that never occurred.
 */

import { createClient } from "@/lib/supabase/server";
import { badRequest, fail, ok, parseNumber, type CachePolicy } from "@/lib/api/respond";
import { resolvePlace } from "@/lib/api/place";
import { pageAll, chunked, mapLimit, stationsPerQuery } from "@/lib/api/data";
import { istToday, toIstDate, toIstHour } from "@/lib/api/time";

// "force-dynamic" means Next runs this code on every request that reaches the
// server instead of building the answer once at deploy time. It does NOT stop
// the shared cache below: for a dynamic route handler Next 14 passes the
// response's own Cache-Control header through untouched (checked in
// node_modules/next/dist/server/base-server.js, Nov 2026), so Vercel's cache
// still serves repeat requests without calling this code at all.
export const dynamic = "force-dynamic";

/**
 * How long Vercel's shared cache keeps a successful answer: one hour fresh,
 * then up to one more hour served while a fresh copy is fetched behind it.
 *
 * THE TRADE-OFF. A visitor may see a chart up to about an hour behind the
 * database (two in the worst case, during the stale window). That costs
 * almost nothing, because new readings arrive only every 6 hours through the
 * ingest workflow. In return, the database is read about once an hour per
 * distinct URL instead of once every 5 minutes. That matters: a Delhi 7-day
 * city view is about 37,000 rows (4-5 MB) per read, and the free plan allows
 * 5 GB of database egress a month. City URLs carry only city/lat/lng, so
 * every visitor looking at the same city shares one cached copy.
 *
 * Errors are not cached (see ok() and fail() in lib/api/respond.ts).
 */
const HISTORY_HOURLY_CACHE_SECONDS = 3600;
const HISTORY_HOURLY_CACHE: CachePolicy = {
  sMaxAgeSeconds: HISTORY_HOURLY_CACHE_SECONDS,
  staleWhileRevalidateSeconds: HISTORY_HOURLY_CACHE_SECONDS,
};

const ALLOWED = new Set(["aqi", "pm25", "pm10", "no2", "so2"]);

/**
 * Hard cap. Seven days across three stations is already a few thousand rows
 * read without a suitable aggregate (a whole city -- Delhi NCR, 79 stations --
 * was 37,000 rows, about 4-5 MB from the database, on 23 Nov 2026); a month
 * would be four times that, and the daily endpoint answers that question
 * better anyway. If city views of this chart become common, an hourly rollup
 * in the database (one row per station-hour, or per city-hour) would cut that
 * transfer several-fold; that needs a migration.
 */
const MAX_DAYS = 7;

/**
 * Readings per station per day to plan requests by: OpenAQ's 15-minute
 * cadence (96). Most stations send fewer (about 84), so a request planned for
 * one page usually fits in one.
 */
const READINGS_PER_STATION_DAY = 96;

/**
 * How many requests run at once here. Higher than the shared
 * MAX_PARALLEL_QUERIES because this route reads raw readings: a city's week
 * is about one request per station (Delhi NCR: ~80), so the wait is mostly
 * round trips, which overlap.
 */
const HOURLY_PARALLEL_QUERIES = 12;

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;

  const pollutant = params.get("pollutant") ?? "aqi";
  if (!ALLOWED.has(pollutant)) {
    return badRequest(`pollutant must be one of: ${Array.from(ALLOWED).join(", ")}`);
  }
  const days = parseNumber(params, "days", 7, 1, MAX_DAYS);

  const supabase = createClient();
  const resolved = await resolvePlace(supabase, params);
  if ("error" in resolved) return fail(resolved.error.message, resolved.error.status);
  const { place } = resolved;

  const ids = place.monitors.map((m) => m.id);
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  // READ IN BATCHES OF STATIONS, EACH PAGED. An unpaginated read would
  // silently analyse the first thousand rows -- for three stations about four
  // days of one pollutant -- and produce a quietly truncated chart rather
  // than an error. Stations are grouped so each request is about one page
  // (stationsPerQuery), and the groups run HOURLY_PARALLEL_QUERIES at a time.
  //
  // ORDERED ON (monitor_id, recorded_at), which is unique for one source
  // (the readings_monitor_source_time_uniq index). Ordering on recorded_at
  // alone, as this did before, ties every station that reported at the same
  // quarter-hour, so a page boundary could repeat some of them and skip
  // others.
  //
  // A single pollutant comes from `measurements`, which holds no timestamp of
  // its own; it is read in the SAME request, nested under each reading
  // (PostgREST "embedding" along measurements.reading_id). `!inner` keeps only
  // readings that have that pollutant. This replaced a second pass of one
  // request per 400 reading ids -- 130+ requests for a city.
  type Row = {
    monitor_id: string;
    recorded_at: string;
    aqi_value?: number | null;
    measurements?: { value: number | null }[];
  };
  const groups = chunked(ids, stationsPerQuery(days * READINGS_PER_STATION_DAY));
  const results = await mapLimit(groups, HOURLY_PARALLEL_QUERIES, (group) =>
    pageAll<Row>((lo, hi) => {
      const base =
        pollutant === "aqi"
          ? supabase
              .from("readings")
              .select("monitor_id, recorded_at, aqi_value")
              .not("aqi_value", "is", null)
          : supabase
              .from("readings")
              .select("monitor_id, recorded_at, measurements!inner(value)")
              .eq("measurements.pollutant", pollutant);
      return (
        base
          .in("monitor_id", group)
          // Official readings only (audit §2.3); see getCurrent.
          .eq("source", "openaq")
          .gte("recorded_at", since)
          .order("monitor_id", { ascending: true })
          .order("recorded_at", { ascending: true })
          .range(lo, hi)
      );
    }),
  );
  // A failed read is "could not load", not "nothing measured" (see DataError).
  const failed = results.find((r) => r.error);
  if (failed) return fail("Could not load hourly history", 502, failed.error);
  const readings = results.flatMap((r) => r.data);
  if (!readings.length) {
    return ok(
      [],
      { pollutant, days, stations: ids.length, points: 0, today: istToday() },
      200,
      HISTORY_HOURLY_CACHE,
    );
  }

  /** "2026-10-08T14" in IST — the bucket a reading belongs to. */
  const keyOf = (iso: string) => `${toIstDate(iso)}T${String(toIstHour(iso)).padStart(2, "0")}`;

  // Each bucket keeps its values and WHICH monitors supplied them. A station
  // reporting every 15 minutes puts four values in an hour, so the number of
  // values is not the number of stations.
  const buckets = new Map<string, { vals: number[]; monitors: Set<string> }>();
  const push = (k: string, v: number, monitorId: string) => {
    const b = buckets.get(k) ?? { vals: [], monitors: new Set<string>() };
    b.vals.push(v);
    b.monitors.add(monitorId);
    buckets.set(k, b);
  };

  for (const r of readings) {
    const value = pollutant === "aqi" ? r.aqi_value : r.measurements?.[0]?.value;
    if (value !== null && value !== undefined) push(keyOf(r.recorded_at), value, r.monitor_id);
  }

  // For a city average, hours when too few of the city's monitoring stations
  // reported are left out, and the chart draws them as gaps. 10% of the same
  // stations the average draws on (resolveCity; CITY_MIN_REPORTING_SHARE).
  const minStations = place.minStations;

  const points = Array.from(buckets.entries())
    .filter(([, b]) => minStations === null || b.monitors.size >= minStations)
    .map(([k, { vals, monitors }]) => {
      const [date, hour] = k.split("T");
      return {
        date,
        hour: Number(hour),
        value:
          Math.round((vals.reduce((t: number, v: number) => t + v, 0) / vals.length) * 10) / 10,
        stations: monitors.size,
      };
    })
    .sort((a, b) => (a.date === b.date ? a.hour - b.hour : a.date.localeCompare(b.date)));

  return ok(
    points,
    {
      pollutant,
      days,
      stations: ids.length,
      points: points.length,
      today: istToday(),
      // City averages only: the fewest reporting stations an hour needed.
      min_stations: minStations,
    },
    200,
    HISTORY_HOURLY_CACHE,
  );
}
