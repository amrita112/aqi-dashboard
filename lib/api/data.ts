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
import { completeDays, stationDayAqi } from "@/lib/api/daily-quality";
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

/** The freshest reading we hold for a station, or null if we hold none. */
export async function getCurrent(
  supabase: SupabaseClient,
  monitor: MonitorRow,
): Promise<CurrentReading | null> {
  const { computeSubIndex } = await import("@/lib/aqi-utils");
  const { DEFAULT_SCALE } = await import("@/lib/types");

  const { data: readings } = await supabase
    .from("readings")
    .select("id, recorded_at")
    .eq("monitor_id", monitor.id)
    // Official readings only. A user-submitted row (source='user') pointing
    // at an official station would otherwise become its "current" reading
    // (audit §2.3). Migration 23 also stops anyone inserting those rows.
    .eq("source", "openaq")
    .order("recorded_at", { ascending: false })
    .limit(1);
  if (!readings?.length) return null;

  const reading = readings[0];
  const { data: measurements } = await supabase
    .from("measurements")
    .select("pollutant, value")
    .eq("reading_id", reading.id);

  const rows = (measurements ?? []).filter(
    (m) => (MEASURED_POLLUTANTS as readonly string[]).includes(m.pollutant) && m.value >= 0,
  );
  if (!rows.length) return null;

  const withSub = rows.map((m) => ({
    pollutant: m.pollutant,
    value: m.value,
    sub_index: computeSubIndex(m.pollutant as never, m.value, DEFAULT_SCALE),
  }));
  const dominant = withSub.reduce((a, b) => (b.sub_index > a.sub_index ? b : a));

  return {
    monitor_id: monitor.id,
    station: monitor.name,
    recorded_at: reading.recorded_at,
    age_hours: Math.round(((Date.now() - Date.parse(reading.recorded_at)) / 3_600_000) * 10) / 10,
    aqi: dominant.sub_index,
    dominant_pollutant: dominant.pollutant,
    pollutants: withSub,
  };
}

/** Stored daily forecast for one station, expanded to IST hours. */
export async function getForecast(
  supabase: SupabaseClient,
  monitor: MonitorRow,
  pollutant: string,
  days: number,
  opts: { includeToday?: boolean } = {},
): Promise<ForecastDay[]> {
  const today = istToday();
  // TODAY'S ROW EXISTS AND WAS BEING THROWN AWAY. The nightly job writes a
  // horizon-1 row for the day it runs, so by the time anyone opens the app
  // there is a forecast for today sitting in the table -- `gt` dropped it and
  // the earliest thing the app could say anything about was tomorrow. That is
  // why "what about this evening" had nothing to answer with.
  //
  // Still EXCLUDED by default, because the Today screen and the forecast list
  // are built around "the days ahead" and silently prepending today would
  // shift every card. Callers that want it ask for it.
  const { data: rows } = await supabase
    .from("forecast_daily")
    .select(
      "monitor_id, pollutant, target_date, horizon_days, value, band_p50, band_p80, mode, model, based_on_date, data_age_days, computed_at",
    )
    .eq("monitor_id", monitor.id)
    .eq("pollutant", pollutant)
    [opts.includeToday ? "gte" : "gt"]("target_date", today)
    .order("target_date", { ascending: true })
    .limit(days);
  if (!rows?.length) return [];

  const analysisCity = APP_TO_ANALYSIS[monitor.city] ?? monitor.city;
  const { data: shapeRows } = await supabase
    .from("diurnal_shape")
    .select("city, pollutant, month, hour, ratio")
    .eq("city", analysisCity)
    .eq("pollutant", pollutant);

  const shape = indexShape((shapeRows ?? []) as ShapeRow[]);
  return (rows as ForecastDailyRow[]).map((r) =>
    expandDay(r, analysisCity, shape, { hourly: true, today }),
  );
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
 * Days of readings_daily read BEFORE `from`, only so the completeness rule can
 * learn each station's cadence (hourly or 15-minute) from a fair sample, as
 * nightly does with its 14-day lookback. Those extra days are not returned.
 */
const CADENCE_LOOKBACK_DAYS = 14;

function shiftIsoDate(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
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

type DailyDbRow = {
  date: string; pollutant: string; mean: number | null; min: number | null;
  max: number | null; min_ts: string | null; max_ts: string | null;
  count: number | null; source: string;
};

async function dailyRows(
  supabase: SupabaseClient,
  monitorId: string,
  pollutants: readonly string[],
  from: string,
  to: string,
): Promise<DailyDbRow[]> {
  const { data } = await pageAll<DailyDbRow>((lo, hi) =>
    supabase
      .from("readings_daily")
      .select("date, pollutant, mean, min, max, min_ts, max_ts, count, source")
      .eq("monitor_id", monitorId)
      .in("pollutant", [...pollutants])
      .gte("date", shiftIsoDate(from, -CADENCE_LOOKBACK_DAYS))
      .lte("date", to)
      .order("date", { ascending: true })
      .order("pollutant", { ascending: true })
      .range(lo, hi),
  );
  return data;
}

/**
 * Daily history for one station: COMPLETE days only (lib/api/daily-quality.ts,
 * the same rule the forecast uses). A partial day is a gap in the chart, not
 * a low point.
 */
export async function getHistory(
  supabase: SupabaseClient,
  monitor: MonitorRow,
  pollutant: string,
  from: string,
  to: string,
): Promise<HistoryPoint[]> {
  if (pollutant === "aqi") return getHistoryAqi(supabase, monitor, from, to);

  const rows = await dailyRows(supabase, monitor.id, [pollutant], from, to);
  return completeDays(rows.map((r) => ({ ...r, monitor_id: monitor.id })))
    .filter((r) => r.date >= from && r.mean !== null)
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
 */
async function getHistoryAqi(
  supabase: SupabaseClient,
  monitor: MonitorRow,
  from: string,
  to: string,
): Promise<HistoryPoint[]> {
  const { computeSubIndex } = await import("@/lib/aqi-utils");
  const { DEFAULT_SCALE } = await import("@/lib/types");
  type P = Parameters<typeof computeSubIndex>[0];

  const rows = await dailyRows(supabase, monitor.id, MEASURED_POLLUTANTS, from, to);
  const complete = completeDays(rows.map((r) => ({ ...r, monitor_id: monitor.id })));
  const qualifying = new Map(stationDayAqi(complete).map((d) => [d.date, d]));

  const byDate = new Map<string, { count: number; source: string; minSub: number[]; maxSub: number[] }>();
  for (const row of complete) {
    if (row.date < from || !qualifying.has(row.date)) continue;
    const slot = byDate.get(row.date) ?? { count: 0, source: row.source, minSub: [], maxSub: [] };
    // The day's extremes are sub-indexed too, so min/max stay on the AQI scale
    // rather than being concentrations mixed into an index series.
    if (row.min !== null && row.min >= 0) slot.minSub.push(computeSubIndex(row.pollutant as P, row.min, DEFAULT_SCALE));
    if (row.max !== null && row.max >= 0) slot.maxSub.push(computeSubIndex(row.pollutant as P, row.max, DEFAULT_SCALE));
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

/** Cap how many stations a city-level question fans out to. */
export const MAX_STATIONS_PER_CITY_QUERY = 8;

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
  if (error || !data) return [];
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
