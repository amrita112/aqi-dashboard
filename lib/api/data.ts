/**
 * The query layer both the REST routes and the AI tools call.
 *
 * It exists so there is exactly one implementation of "what is the forecast
 * for this station". If the /api/forecast route and the `forecast` tool each
 * had their own, they would answer the same question differently the first
 * time one of them was changed — and the user would have no way to tell which
 * was right.
 *
 * Everything here returns plain objects. Presentation (band colours, IST
 * strings) happens in lib/api/forecast.ts, which both callers also share.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  indexShape,
  expandDay,
  bandFor,
  type ForecastDailyRow,
  type ForecastDay,
  type ShapeRow,
} from "@/lib/api/forecast";
import { istToday } from "@/lib/api/time";
import { completeDays, meetsAqiRule, stationDayAqi } from "@/lib/api/daily-quality";
import { DEFAULT_SCALE, type Scale } from "@/lib/types";

/** monitors.city uses the app's spelling; the analysis tables use XKDR's. */
export const APP_TO_ANALYSIS: Record<string, string> = {
  "Delhi NCR": "Delhi",
  Bangalore: "Bengaluru",
};

export const MEASURED_POLLUTANTS = ["pm25", "pm10", "no2", "so2"] as const;
export const FORECASTABLE = ["aqi", "pm25"] as const;

export interface MonitorRow {
  id: string;
  name: string;
  city: string;
  latitude: number;
  longitude: number;
}

export interface ResolvedLocation {
  /**
   * `station` when the text named one, `city` when it named a whole city, and
   * `point` when nothing matched and the asker's own coordinates were used —
   * which is how a neighbourhood with no station of its own gets an answer.
   */
  kind: "station" | "city" | "point";
  city: string;
  label: string;
  monitors: MonitorRow[];
}

/**
 * Turn free text ("Delhi", "Anand Vihar", "bengaluru") into monitors.
 *
 * The app itself has no geolocation — every user picks a place explicitly —
 * but the AI box receives whatever someone types, so this is where loose input
 * gets pinned to something real. Returns null rather than guessing when
 * nothing matches: a wrong city silently answered is worse than "I don't know
 * that place".
 */
export async function resolveLocation(
  supabase: SupabaseClient,
  text: string,
): Promise<ResolvedLocation | null> {
  const needle = text.trim().toLowerCase();
  if (!needle) return null;

  const { data, error } = await supabase
    .from("monitors")
    .select("id, name, city, latitude, longitude")
    .not("city", "is", null);
  if (error || !data?.length) return null;

  const monitors = data as MonitorRow[];

  // A city name wins over a station name. Someone typing "Delhi" means the
  // city, even though several stations have "Delhi" in their own name.
  const cities = Array.from(new Set(monitors.map((m) => m.city)));
  const cityHit =
    cities.find((c) => c.toLowerCase() === needle) ??
    cities.find((c) => c.toLowerCase().replace(/\s+ncr$/, "") === needle) ??
    cities.find((c) => c.toLowerCase().includes(needle) && needle.length >= 4);
  if (cityHit) {
    return {
      kind: "city",
      city: cityHit,
      label: cityHit,
      monitors: monitors.filter((m) => m.city === cityHit),
    };
  }

  const exact = monitors.find((m) => m.name?.toLowerCase() === needle);
  const partial =
    exact ?? monitors.find((m) => m.name?.toLowerCase().includes(needle) && needle.length >= 3);
  if (partial) {
    return { kind: "station", city: partial.city, label: partial.name, monitors: [partial] };
  }
  return null;
}

export interface CurrentReading {
  monitor_id: string;
  station: string;
  recorded_at: string;
  age_hours: number;
  aqi: number;
  dominant_pollutant: string;
  pollutants: { pollutant: string; value: number; sub_index: number }[];
}

/**
 * How many of a station's newest readings to look through for one that can
 * carry an AQI. OpenAQ publishes pollutants in separate bursts, so the latest
 * timestamp often has only NO2 or SO2 so far, and its "AQI" would understate
 * the air.
 */
const CURRENT_LOOKBACK_READINGS = 12;

/** The freshest reading we hold for a station, or null if we hold none. */
export async function getCurrent(
  supabase: SupabaseClient,
  monitor: MonitorRow,
): Promise<CurrentReading | null> {
  return (await getCurrentMany(supabase, [monitor])).get(monitor.id) ?? null;
}

/**
 * The freshest reading for EACH of several stations, in ONE database request.
 *
 * WHY ONE REQUEST. A city average now uses every station in the city (Delhi
 * NCR: 79). Asking station by station meant two requests each -- 158 for one
 * question. Instead this asks the monitors table for the stations and, nested
 * inside each one (PostgREST "embedding": following the link from a reading
 * to its station), that station's newest few official readings with their
 * pollutant values. The limit on the nested readings applies PER STATION, so
 * this is the same "newest 12 readings of each station" as before.
 *
 * The 1000-row cap applies to the top-level rows only, which here are the
 * stations (at most a few dozen per request; see MONITORS_PER_QUERY).
 *
 * THE NEWEST READING THAT CAN CARRY AN AQI, not simply the newest: the
 * lookback finds one that meets the AQI rule (both PMs by default;
 * lib/daily-quality-config.json) -- the same rule as everywhere else.
 *
 * Returns a map from station id to its reading; a station with no usable
 * reading is simply absent.
 */
export async function getCurrentMany(
  supabase: SupabaseClient,
  monitors: MonitorRow[],
): Promise<Map<string, CurrentReading>> {
  const { computeSubIndex } = await import("@/lib/aqi-utils");
  const { DEFAULT_SCALE } = await import("@/lib/types");

  type Embedded = {
    id: string;
    readings: { id: string; recorded_at: string; measurements: { pollutant: string; value: number }[] }[] | null;
  };
  const chunks = chunked(monitors.map((m) => m.id), MONITORS_PER_QUERY);
  const results = await mapLimit(chunks, MAX_PARALLEL_QUERIES, async (ids) => {
    const { data } = await supabase
      .from("monitors")
      .select("id, readings(id, recorded_at, measurements(pollutant, value))")
      .in("id", ids)
      // Official readings only. A user-submitted row (source='user') pointing
      // at an official station would otherwise become its "current" reading
      // (audit §2.3). Migration 24 also stops anyone inserting those rows.
      .eq("readings.source", "openaq")
      .order("recorded_at", { referencedTable: "readings", ascending: false })
      .limit(CURRENT_LOOKBACK_READINGS, { referencedTable: "readings" });
    return (data ?? []) as Embedded[];
  });

  const byId = new Map(monitors.map((m) => [m.id, m]));
  const out = new Map<string, CurrentReading>();
  for (const row of results.flat()) {
    const monitor = byId.get(row.id);
    if (!monitor) continue;
    // Newest first; re-sorted here rather than trusting the nested order.
    const readings = [...(row.readings ?? [])].sort(
      (a, b) => Date.parse(b.recorded_at) - Date.parse(a.recorded_at),
    );
    const usableFor = (r: Embedded["readings"] extends (infer R)[] | null ? R : never) =>
      (r.measurements ?? []).filter(
        (m) => (MEASURED_POLLUTANTS as readonly string[]).includes(m.pollutant) && m.value >= 0,
      );
    const reading = readings.find((r) => meetsAqiRule(usableFor(r).map((m) => m.pollutant)));
    if (!reading) continue;

    const withSub = usableFor(reading).map((m) => ({
      pollutant: m.pollutant,
      value: m.value,
      sub_index: computeSubIndex(m.pollutant as never, m.value, DEFAULT_SCALE),
    }));
    const dominant = withSub.reduce((a, b) => (b.sub_index > a.sub_index ? b : a));

    out.set(monitor.id, {
      monitor_id: monitor.id,
      station: monitor.name,
      recorded_at: reading.recorded_at,
      age_hours: Math.round(((Date.now() - Date.parse(reading.recorded_at)) / 3_600_000) * 10) / 10,
      aqi: dominant.sub_index,
      dominant_pollutant: dominant.pollutant,
      pollutants: withSub,
    });
  }
  return out;
}

/** Stored daily forecast for one station, expanded to IST hours. */
export async function getForecast(
  supabase: SupabaseClient,
  monitor: MonitorRow,
  pollutant: string,
  days: number,
  opts: { includeToday?: boolean } = {},
): Promise<ForecastDay[]> {
  return (await getForecastMany(supabase, [monitor], pollutant, days, opts)).get(monitor.id) ?? [];
}

/**
 * Stored daily forecast for EACH of several stations, expanded to IST hours:
 * for every station, its next `days` rows, exactly as getForecast gives one.
 *
 * WHY BATCHED. A city average now uses every station in the city (Delhi NCR:
 * 79). Station by station that was two requests each (the forecast rows and
 * the city's hourly shape) -- 158 for one screen. Here the rows for many
 * stations come in one request per MONITORS_PER_QUERY stations, and the
 * hourly shape is read once per city rather than once per station. Each row
 * is then expanded by the same expandDay as before, so the numbers do not
 * change; only how they are fetched.
 *
 * Returns a map from station id to its days; every requested station has an
 * entry (possibly empty).
 */
export async function getForecastMany(
  supabase: SupabaseClient,
  monitors: MonitorRow[],
  pollutant: string,
  days: number,
  opts: { includeToday?: boolean } = {},
): Promise<Map<string, ForecastDay[]>> {
  const today = istToday();
  const out = new Map<string, ForecastDay[]>(monitors.map((m) => [m.id, []]));
  if (!monitors.length) return out;

  // TODAY'S ROW EXISTS AND WAS BEING THROWN AWAY. The nightly job writes a
  // horizon-1 row for the day it runs, so by the time anyone opens the app
  // there is a forecast for today sitting in the table -- `gt` dropped it and
  // the earliest thing the app could say anything about was tomorrow. That is
  // why "what about this evening" had nothing to answer with.
  //
  // Still EXCLUDED by default, because the Today screen and the forecast list
  // are built around "the days ahead" and silently prepending today would
  // shift every card. Callers that want it ask for it.
  //
  // Every future row of these stations: the table holds at most one row per
  // (station, pollutant, day) -- its primary key -- and only the next seven
  // or so days, so a few dozen stations stay well inside one page. Ordered
  // by (monitor_id, target_date), unique for one pollutant, so pages cannot
  // overlap or skip; each station's first `days` rows are taken below, which
  // is what `.limit(days)` did for one station.
  const chunks = chunked(monitors.map((m) => m.id), MONITORS_PER_QUERY);
  const pages = await mapLimit(chunks, MAX_PARALLEL_QUERIES, async (ids) => {
    const { data, error } = await pageAll<ForecastDailyRow>((lo, hi) =>
        supabase
          .from("forecast_daily")
          .select(
            "monitor_id, pollutant, target_date, horizon_days, value, band_p50, band_p80, mode, model, based_on_date, data_age_days, computed_at",
          )
          .in("monitor_id", ids)
          .eq("pollutant", pollutant)
          [opts.includeToday ? "gte" : "gt"]("target_date", today)
          .order("monitor_id", { ascending: true })
          .order("target_date", { ascending: true })
          .range(lo, hi),
    );
    // As before batching: a failed read gives these stations no forecast
    // (the route then says none is stored), never half a list.
    return error ? [] : data;
  });
  const rowsByMonitor = new Map<string, ForecastDailyRow[]>();
  for (const r of pages.flat()) {
    const list = rowsByMonitor.get(r.monitor_id) ?? [];
    list.push(r);
    rowsByMonitor.set(r.monitor_id, list);
  }

  // The hourly shape is per CITY, so it is read once per city in the batch
  // (normally one), not once per station.
  const cities = Array.from(new Set(monitors.map((m) => APP_TO_ANALYSIS[m.city] ?? m.city)));
  const shapes = new Map(
    await Promise.all(
      cities.map(async (analysisCity) => {
        const { data: shapeRows } = await supabase
          .from("diurnal_shape")
          .select("city, pollutant, month, hour, ratio")
          .eq("city", analysisCity)
          .eq("pollutant", pollutant);
        return [analysisCity, indexShape((shapeRows ?? []) as ShapeRow[])] as const;
      }),
    ),
  );

  for (const monitor of monitors) {
    const rows = (rowsByMonitor.get(monitor.id) ?? [])
      .sort((a, b) => a.target_date.localeCompare(b.target_date))
      .slice(0, days);
    const analysisCity = APP_TO_ANALYSIS[monitor.city] ?? monitor.city;
    const shape = shapes.get(analysisCity) ?? new Map<string, number[]>();
    out.set(
      monitor.id,
      rows.map((r) => expandDay(r, analysisCity, shape, { hourly: true, today })),
    );
  }
  return out;
}

/**
 * The database could not be read -- as opposed to "it was read and held
 * nothing". The two used to look identical: a failed query came back as an
 * empty list, so the Trends screen said "Nothing was measured near this place"
 * when the real answer was "the query broke" (Nov 2026: a column the code
 * asked for had not been added to the database yet). Throwing this instead
 * lets each caller say what actually happened.
 *
 * `detail` carries the raw database error for the SERVER LOG only; routes
 * pass it to fail(), which keeps it out of the response.
 */
export class DataError extends Error {
  constructor(
    message: string,
    public readonly detail: unknown,
  ) {
    super(message);
    this.name = "DataError";
  }
}

export interface HistoryPoint {
  date: string;
  mean: number;
  min: number;
  max: number;
  count: number;
  source: string;
  /** When the day's min and max occurred (single pollutants only). */
  min_ts?: string | null;
  max_ts?: string | null;
}

/**
 * Every row of a query, 1,000 at a time. PostgREST silently stops at 1,000
 * rows, so an unpaged query over a long range (the AI's 365-day history, the
 * 80-station map) quietly lost rows -- for history, the MOST RECENT days,
 * because the order is ascending (audit §7.5). The query must be ordered, or
 * pages can overlap or skip.
 */
export async function pageAll<T>(
  page: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: unknown }>,
  pageSize = 1000,
): Promise<{ data: T[]; error: unknown }> {
  const out: T[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await page(offset, offset + pageSize - 1);
    if (error) return { data: out, error };
    const batch = (data ?? []) as T[];
    out.push(...batch);
    if (batch.length < pageSize) return { data: out, error: null };
  }
}

// ─── Reading many stations without one request per station ─────────────────
//
// A city average uses every active station in the city (Delhi NCR: 79), so
// "one request per station" would mean dozens or hundreds of requests per
// screen. Instead the stations are put into a few requests with
// `.in("monitor_id", [...])`, and those requests run a few at a time.

/** PostgREST's row cap per response (the project's "max rows" setting). */
export const PAGE_ROWS = 1000;

/**
 * At most this many stations in one request. Each station id is 36
 * characters in the request's web address, and very long addresses can be
 * refused, so even tiny tables are split at this size.
 */
export const MONITORS_PER_QUERY = 40;

/**
 * At most this many requests in flight at once for one answer: enough to
 * overlap the waiting, few enough not to crowd the database's connection
 * pool (the small Supabase plans have tens of connections, shared by
 * everyone using the app).
 */
export const MAX_PARALLEL_QUERIES = 8;

/**
 * How many stations to put in one request when each station brings about
 * `rowsPerStation` rows: enough that a request is about one page, at least
 * one, at most MONITORS_PER_QUERY.
 */
export function stationsPerQuery(rowsPerStation: number): number {
  return Math.max(1, Math.min(MONITORS_PER_QUERY, Math.floor(PAGE_ROWS / Math.max(1, rowsPerStation))));
}

/** Split a list into pieces of at most `size`. */
export function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += Math.max(1, size)) out.push(items.slice(i, i + Math.max(1, size)));
  return out;
}

/**
 * Run `fn` on every item, at most `limit` at a time, keeping the results in
 * the items' order (like Promise.all, but without starting everything at once).
 */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return out;
}

type DailyDbRow = {
  monitor_id: string; date: string; pollutant: string; mean: number | null; min: number | null;
  max: number | null; min_ts: string | null; max_ts: string | null;
  count: number | null; source: string; is_complete: boolean | null;
};

/**
 * readings_daily rows for several stations, a few stations per request.
 *
 * How many stations share a request is worked out from the window, so each
 * request is about one page (rowsPerStation x stations <= PAGE_ROWS): a
 * 30-day AQI history (4 pollutants) puts 8 stations in a request, a 365-day
 * one puts 1. The requests run MAX_PARALLEL_QUERIES at a time, and each is
 * still paged, ordered on (monitor_id, date, pollutant) -- the table's
 * primary key -- so pages never overlap or skip.
 */
async function dailyRowsMany(
  supabase: SupabaseClient,
  monitorIds: string[],
  pollutants: readonly string[],
  from: string,
  to: string,
): Promise<DailyDbRow[]> {
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
  const perQuery = stationsPerQuery(Math.max(1, days) * pollutants.length);
  const chunks = chunked(monitorIds, perQuery);
  const results = await mapLimit(chunks, MAX_PARALLEL_QUERIES, (ids) =>
    pageAll<DailyDbRow>((lo, hi) =>
      supabase
        .from("readings_daily")
        .select("monitor_id, date, pollutant, mean, min, max, min_ts, max_ts, count, source, is_complete")
        .in("monitor_id", ids)
        .in("pollutant", [...pollutants])
        .gte("date", from)
        .lte("date", to)
        .order("monitor_id", { ascending: true })
        .order("date", { ascending: true })
        .order("pollutant", { ascending: true })
        .range(lo, hi),
    ),
  );
  // A failed read is an error, not an empty history. Returning `data` here
  // (an empty or partial list) is how a database error reached the screen as
  // "nothing was measured". Partial pages are not returned either: half a
  // window drawn as if it were the whole one is the same mistake, smaller.
  const failed = results.find((r) => r.error);
  if (failed) throw new DataError("Could not load daily readings", failed.error);
  return results.flatMap((r) => r.data);
}

/**
 * Daily history for one station: the days the rollup marked COMPLETE
 * (readings_daily.is_complete, the same verdict the forecast uses). A partial
 * day is a gap in the chart, not a low point.
 *
 * Throws DataError when the database cannot be read, so an empty result
 * always means "nothing complete was measured", never "the query failed".
 */
export async function getHistory(
  supabase: SupabaseClient,
  monitor: MonitorRow,
  pollutant: string,
  from: string,
  to: string,
): Promise<HistoryPoint[]> {
  return (await getHistoryMany(supabase, [monitor], pollutant, from, to)).get(monitor.id) ?? [];
}

/**
 * Daily history for EACH of several stations, as getHistory gives one, read
 * in batches (see dailyRowsMany) rather than one request per station. A city
 * average now draws on every station in the city (Delhi NCR: 79).
 *
 * Returns a map from station id to its series; every requested station has
 * an entry (possibly empty). Throws DataError if any batch fails: an average
 * quietly missing some of its stations is a different number.
 */
export async function getHistoryMany(
  supabase: SupabaseClient,
  monitors: MonitorRow[],
  pollutant: string,
  from: string,
  to: string,
): Promise<Map<string, HistoryPoint[]>> {
  const out = new Map<string, HistoryPoint[]>(monitors.map((m) => [m.id, []]));
  if (!monitors.length) return out;
  const pollutants = pollutant === "aqi" ? MEASURED_POLLUTANTS : [pollutant];
  const rows = await dailyRowsMany(supabase, monitors.map((m) => m.id), pollutants, from, to);
  const byMonitor = new Map<string, DailyDbRow[]>();
  for (const r of rows) {
    const list = byMonitor.get(r.monitor_id) ?? [];
    list.push(r);
    byMonitor.set(r.monitor_id, list);
  }
  const { computeSubIndex } = await import("@/lib/aqi-utils");
  const { DEFAULT_SCALE } = await import("@/lib/types");
  for (const m of monitors) {
    const mine = (byMonitor.get(m.id) ?? []).sort(
      (a, b) => a.date.localeCompare(b.date) || a.pollutant.localeCompare(b.pollutant),
    );
    out.set(
      m.id,
      pollutant === "aqi"
        ? historyAqiFromRows(mine, computeSubIndex, DEFAULT_SCALE)
        : historyFromRows(mine),
    );
  }
  return out;
}

/** One station's single-pollutant series from its readings_daily rows. */
function historyFromRows(rows: DailyDbRow[]): HistoryPoint[] {
  return completeDays(rows)
    .filter((r) => r.mean !== null)
    .map((r) => ({
      date: r.date,
      mean: r.mean as number,
      min: r.min ?? (r.mean as number),
      max: r.max ?? (r.mean as number),
      count: r.count ?? 0,
      source: r.source,
      min_ts: r.min_ts,
      max_ts: r.max_ts,
    }));
}

/**
 * Composite AQI history, derived rather than stored.
 *
 * `readings_daily` holds only the four MEASURED pollutants. Composite AQI is
 * not a measurement -- it is the max of their sub-indices -- so it is computed
 * from the day's rows: each COMPLETE pollutant's daily mean -> its sub-index ->
 * the max, on days that meet the AQI rule (both PMs by default; see
 * lib/daily-quality-config.json). Taking a max across different days would
 * invent an AQI that never happened.
 *
 * `rows` are ONE station's rows (all four pollutants).
 */
function historyAqiFromRows(
  rows: DailyDbRow[],
  computeSubIndex: typeof import("@/lib/aqi-utils").computeSubIndex,
  scale: Scale,
): HistoryPoint[] {
  type P = Parameters<typeof computeSubIndex>[0];
  const complete = completeDays(rows);
  const qualifying = new Map(stationDayAqi(complete).map((d) => [d.date, d]));

  const byDate = new Map<string, { count: number; source: string; minSub: number[]; maxSub: number[] }>();
  for (const row of complete) {
    if (!qualifying.has(row.date)) continue;
    const slot = byDate.get(row.date) ?? { count: 0, source: row.source, minSub: [], maxSub: [] };
    // The day's extremes are sub-indexed too, so min/max stay on the AQI scale
    // rather than being concentrations mixed into an index series.
    if (row.min !== null && row.min >= 0) slot.minSub.push(computeSubIndex(row.pollutant as P, row.min, scale));
    if (row.max !== null && row.max >= 0) slot.maxSub.push(computeSubIndex(row.pollutant as P, row.max, scale));
    slot.count += row.count ?? 0;
    byDate.set(row.date, slot);
  }

  return Array.from(byDate.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, s]) => {
      const aqi = qualifying.get(date)!.aqi;
      return {
        date,
        mean: aqi,
        min: s.minSub.length ? Math.max(...s.minSub) : aqi,
        max: s.maxSub.length ? Math.max(...s.maxSub) : aqi,
        // Summed across the pollutants behind the day, so the completeness
        // denominator in the route accounts for that -- see
        // HISTORY_POLLUTANT_MULTIPLIER.
        count: s.count,
        source: s.source,
      };
    });
}

/**
 * Average a value across the stations of a location.
 *
 * A city's number is the mean across its stations, which is how every city
 * figure in this project is built — averaging raw readings instead would let
 * the busiest station set the city's number.
 */
export function meanAcross(values: number[]): number | null {
  const usable = values.filter((v) => Number.isFinite(v));
  if (!usable.length) return null;
  return Math.round((usable.reduce((a, b) => a + b, 0) / usable.length) * 10) / 10;
}

// ─── Averaging over the stations nearest a place ────────────────────────────
//
// A person is at a place, not at a monitor. Answering from whichever single
// station happens to be first alphabetically is arbitrary, and answering from
// the city mean throws away the fact that Anand Vihar and Lodhi Road are
// genuinely different air. Averaging the few nearest stations to the point
// they chose is the honest middle.
//
// It also rescues thin stations. A monitor with 37 days of history can only
// ever serve the seasonal normal, but its neighbours 3 km away may have years
// of it -- so a location answered from its neighbourhood gets a real forecast
// where that one station could not give one.
//
// PLAIN MEAN, NOT INVERSE-DISTANCE WEIGHTED. Every city figure in this project
// is a plain mean across stations, and staying consistent matters more than
// the marginal gain from weighting three stations inside a 25 km cap.

export const DEFAULT_NEAREST_K = 3;
export const DEFAULT_MAX_KM = 25;

export interface NearbyMonitor extends MonitorRow {
  distance_km: number;
}

/**
 * The k nearest stations to a point, nearest first.
 *
 * `max_km` is not optional in spirit: without it a user in a city with three
 * working stations silently gets a fourth from 200 km away averaged in as
 * though it described their air.
 */
export async function nearestMonitors(
  supabase: SupabaseClient,
  lat: number,
  lng: number,
  k = DEFAULT_NEAREST_K,
  maxKm = DEFAULT_MAX_KM,
  city: string | null = null,
): Promise<NearbyMonitor[]> {
  const { data, error } = await supabase.rpc("nearest_monitors", {
    lat,
    lng,
    k,
    max_km: maxKm,
    want_city: city,
  });
  // A failed lookup is not "no stations nearby". Treating it as one made a
  // database problem look like a place with no monitors (a 404 saying "No
  // stations within 30 km"), which sends the person looking in the wrong place.
  if (error) throw new DataError("Could not look up nearby stations", error);
  if (!data) return [];
  return (data as { monitor_id: string; name: string; city: string; latitude: number; longitude: number; distance_km: number }[])
    .map((r) => ({
      id: r.monitor_id,
      name: r.name,
      city: r.city,
      latitude: r.latitude,
      longitude: r.longitude,
      distance_km: Math.round(r.distance_km * 100) / 100,
    }));
}

export interface Averaged<T> {
  value: T;
  stations: { monitor_id: string; name: string; distance_km: number }[];
}

function describe(monitors: NearbyMonitor[]) {
  return monitors.map((m) => ({
    monitor_id: m.id,
    name: m.name,
    distance_km: m.distance_km,
  }));
}

/**
 * Average the day+N forecast across nearby stations.
 *
 * Stations serving `seasonal_normal` are EXCLUDED whenever at least one
 * neighbour has a real forecast. A seasonal_normal row carries no information
 * about tomorrow -- it is the long-run average -- so blending it in would drag
 * the anomaly toward zero, which is the same over-smoothing this pipeline
 * spent a week removing. When nobody nearby has a real forecast, the seasonal
 * normals are averaged and the result is honestly labelled as such.
 */
export function averageForecastDays(
  perStation: { monitor: NearbyMonitor; days: ForecastDay[] }[],
  horizonCount: number,
  // Needed to re-derive the band from the averaged value. ForecastDay carries
  // no pollutant of its own, and inheriting the first station's band is the bug
  // this argument exists to prevent.
  pollutant: string,
  scale: Scale = DEFAULT_SCALE,
): Averaged<ForecastDay[]> | null {
  const withData = perStation.filter((p) => p.days.length);
  if (!withData.length) return null;

  const out: ForecastDay[] = [];
  const used = new Map<string, NearbyMonitor>();

  // GROUP BY DATE, NOT BY POSITION. `p.days[i]` assumed every station had a
  // row for every day. When one did not -- a new station with no row for
  // today, a day skipped because its climatology was 0, stale rows from a
  // monitor that left the station list -- day i of one station was averaged
  // with day i+1 of another, and the result was labelled with the first
  // station's date (audit §7.4).
  const dates = Array.from(
    new Set(withData.flatMap((p) => p.days.map((d) => d.target_date))),
  )
    .sort()
    .slice(0, horizonCount);

  for (const date of dates) {
    const slice = withData
      .map((p) => ({ monitor: p.monitor, day: p.days.find((d) => d.target_date === date) }))
      .filter((x): x is { monitor: NearbyMonitor; day: ForecastDay } => Boolean(x.day));
    if (!slice.length) continue;

    const real = slice.filter((x) => x.day.mode !== "seasonal_normal");
    const contributing = real.length ? real : slice;
    for (const c of contributing) used.set(c.monitor.id, c.monitor);

    const base = contributing[0].day;
    const mean = (pick: (d: ForecastDay) => number | null) =>
      meanAcross(contributing.map((c) => pick(c.day) ?? NaN));

    // RECOMPUTE THE BAND FROM THE AVERAGED VALUE. Spreading `...h` and
    // overriding only `value` left each point wearing the FIRST station's band
    // while displaying the average of all of them, so the colour and the label
    // described a number that was no longer on screen. A Bangalore forecast of
    // 59 was shown as "Severe" because the first contributing station's band
    // happened to be that.
    const hourly = base.hourly
      ? base.hourly.map((h, hour) => {
          const value = mean((d) => d.hourly?.[hour]?.value ?? null) ?? h.value;
          return {
            ...h,
            value,
            band_low: mean((d) => d.hourly?.[hour]?.band_low ?? null),
            band_high: mean((d) => d.hourly?.[hour]?.band_high ?? null),
            band: bandFor(pollutant, value, scale),
          };
        })
      : null;

    const dayValue = mean((d) => d.value) ?? base.value;

    out.push({
      ...base,
      value: dayValue,
      band: bandFor(pollutant, dayValue, scale),
      band_low: mean((d) => d.band_low),
      band_high: mean((d) => d.band_high),
      // Honest label: only a real forecast if the rows behind it were.
      mode: real.length ? base.mode : "seasonal_normal",
      data_age_days: mean((d) => d.data_age_days) ?? base.data_age_days,
      hourly,
      hourly_is_flat: contributing.every((c) => c.day.hourly_is_flat),
    });
  }

  if (!out.length) return null;
  const ordered = Array.from(used.values()).sort((a, b) => a.distance_km - b.distance_km);
  return { value: out, stations: describe(ordered) };
}

/**
 * Average the freshest reading across nearby stations.
 *
 * Age is reported as the OLDEST contributor, not the average: a blend is only
 * as current as its stalest input, and rounding that down would overstate how
 * fresh the answer is.
 */
export function averageCurrent(
  perStation: { monitor: NearbyMonitor; reading: CurrentReading | null }[],
): Averaged<{
  aqi: number;
  dominant_pollutant: string;
  age_hours: number;
  pollutants: { pollutant: string; value: number }[];
}> | null {
  const withData = perStation.filter(
    (p): p is { monitor: NearbyMonitor; reading: CurrentReading } => p.reading !== null,
  );
  if (!withData.length) return null;

  const aqi = meanAcross(withData.map((p) => p.reading.aqi));
  if (aqi === null) return null;

  // Per-pollutant means across whichever stations reported each one.
  const byPollutant = new Map<string, number[]>();
  for (const p of withData) {
    for (const m of p.reading.pollutants) {
      byPollutant.set(m.pollutant, [...(byPollutant.get(m.pollutant) ?? []), m.value]);
    }
  }
  const pollutants = Array.from(byPollutant.entries())
    .map(([pollutant, values]) => ({ pollutant, value: meanAcross(values) ?? 0 }))
    .sort((a, b) => a.pollutant.localeCompare(b.pollutant));

  // The pollutant driving the index most often across the contributors.
  const votes = new Map<string, number>();
  for (const p of withData) {
    votes.set(p.reading.dominant_pollutant, (votes.get(p.reading.dominant_pollutant) ?? 0) + 1);
  }
  const dominant = Array.from(votes.entries()).sort((a, b) => b[1] - a[1])[0][0];

  return {
    value: {
      aqi: Math.round(aqi),
      dominant_pollutant: dominant,
      age_hours: Math.max(...withData.map((p) => p.reading.age_hours)),
      pollutants,
    },
    stations: describe(withData.map((p) => p.monitor)),
  };
}

export interface AveragedHistoryPoint {
  date: string;
  mean: number;
  min: number;
  max: number;
  stations: number;
  count: number;
  source: string;
}

/**
 * Average the daily history across nearby stations, date by date.
 *
 * `stations` is per-day on purpose: coverage is uneven, monitors go quiet, and
 * a day backed by one station is a different claim from one backed by three.
 * A chart that hides that draws a smooth line through a gap.
 */
export function averageHistory(
  perStation: { monitor: NearbyMonitor; series: HistoryPoint[] }[],
): Averaged<AveragedHistoryPoint[]> {
  const byDate = new Map<string, { points: HistoryPoint[]; monitors: NearbyMonitor[] }>();
  for (const p of perStation) {
    for (const row of p.series) {
      const slot = byDate.get(row.date) ?? { points: [], monitors: [] };
      slot.points.push(row);
      slot.monitors.push(p.monitor);
      byDate.set(row.date, slot);
    }
  }

  const dates = Array.from(byDate.keys()).sort();
  const series: AveragedHistoryPoint[] = [];
  const used = new Map<string, NearbyMonitor>();

  for (const date of dates) {
    const { points, monitors } = byDate.get(date)!;
    for (const m of monitors) used.set(m.id, m);
    const mean = meanAcross(points.map((p) => p.mean));
    if (mean === null) continue;
    series.push({
      date,
      mean,
      // Min and max are the extremes seen anywhere in the neighbourhood, not
      // an average of extremes, which would understate both.
      min: Math.min(...points.map((p) => p.min)),
      max: Math.max(...points.map((p) => p.max)),
      stations: points.length,
      count: points.reduce((s, p) => s + p.count, 0),
      source: points[0].source,
    });
  }

  const ordered = Array.from(used.values()).sort((a, b) => a.distance_km - b.distance_km);
  return { value: series, stations: describe(ordered) };
}
