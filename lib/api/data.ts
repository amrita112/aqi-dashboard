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
  type ForecastDailyRow,
  type ForecastDay,
  type ShapeRow,
} from "@/lib/api/forecast";
import { istToday } from "@/lib/api/time";

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
  /** `station` when the text named one; `city` when it named a whole city. */
  kind: "station" | "city";
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
): Promise<ForecastDay[]> {
  const today = istToday();
  const { data: rows } = await supabase
    .from("forecast_daily")
    .select(
      "monitor_id, pollutant, target_date, horizon_days, value, band_p50, band_p80, mode, model, based_on_date, data_age_days",
    )
    .eq("monitor_id", monitor.id)
    .eq("pollutant", pollutant)
    .gt("target_date", today)
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
  return (rows as ForecastDailyRow[]).map((r) => expandDay(r, analysisCity, shape, { hourly: true }));
}

export interface HistoryPoint {
  date: string;
  mean: number;
  min: number;
  max: number;
  count: number;
  source: string;
}

export async function getHistory(
  supabase: SupabaseClient,
  monitor: MonitorRow,
  pollutant: string,
  from: string,
  to: string,
): Promise<HistoryPoint[]> {
  const { data } = await supabase
    .from("readings_daily")
    .select("date, mean, min, max, count, source")
    .eq("monitor_id", monitor.id)
    .eq("pollutant", pollutant)
    .gte("date", from)
    .lte("date", to)
    .order("date", { ascending: true });
  return (data ?? []) as HistoryPoint[];
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
