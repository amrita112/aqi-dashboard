/**
 * GET /api/history-hourly?lat=&lng=&k=&pollutant=&days=
 *
 * Measured values hour by hour, averaged across the nearby stations — the
 * shape of the last few days rather than one number per day.
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
import { badRequest, fail, ok, parseNumber } from "@/lib/api/respond";
import { resolvePlace, cityMinStations } from "@/lib/api/place";
import { istToday, toIstDate, toIstHour } from "@/lib/api/time";

export const dynamic = "force-dynamic";

const ALLOWED = new Set(["aqi", "pm25", "pm10", "no2", "so2"]);

/**
 * Hard cap. Seven days across three stations is already a few thousand rows
 * read without a suitable aggregate; a month would be tens of thousands, and
 * the daily endpoint answers that question better anyway.
 */
const MAX_DAYS = 7;

/** PostgREST caps a response at 1000 rows and says nothing about it. */
const PAGE = 1000;

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

  // Paged explicitly. An unpaginated read would silently analyse the first
  // thousand rows — for three stations about four days of one pollutant — and
  // produce a quietly truncated chart rather than an error.
  async function pageAll<T>(
    build: (from: number, to: number) => PromiseLike<{ data: T[] | null }>,
  ): Promise<T[]> {
    const out: T[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const { data } = await build(offset, offset + PAGE - 1);
      const batch = data ?? [];
      out.push(...batch);
      if (batch.length < PAGE) return out;
    }
  }

  const readings = await pageAll<{
    id: string;
    monitor_id: string;
    recorded_at: string;
    aqi_value: number | null;
  }>((lo, hi) =>
    supabase
      .from("readings")
      .select("id, monitor_id, recorded_at, aqi_value")
      .in("monitor_id", ids)
      .gte("recorded_at", since)
      .order("recorded_at", { ascending: true })
      .range(lo, hi),
  );
  if (!readings.length) {
    return ok([], { pollutant, days, stations: ids.length, points: 0, today: istToday() });
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

  if (pollutant === "aqi") {
    for (const r of readings) {
      if (r.aqi_value !== null) push(keyOf(r.recorded_at), r.aqi_value, r.monitor_id);
    }
  } else {
    const whenOf = new Map(readings.map((r) => [r.id, r.recorded_at]));
    const monitorOf = new Map(readings.map((r) => [r.id, r.monitor_id]));
    const idList = Array.from(whenOf.keys());
    // Batched by reading id, and paged WITHIN each batch: measurements carries
    // no timestamp of its own, and a batch of 400 ids can exceed the row cap.
    const BATCH = 400;
    for (let i = 0; i < idList.length; i += BATCH) {
      const slice = idList.slice(i, i + BATCH);
      const rows = await pageAll<{ reading_id: string; value: number | null }>((lo, hi) =>
        supabase
          .from("measurements")
          .select("reading_id, value")
          .eq("pollutant", pollutant)
          .in("reading_id", slice)
          .range(lo, hi),
      );
      for (const m of rows) {
        const ts = whenOf.get(m.reading_id);
        if (ts && m.value !== null) push(keyOf(ts), m.value, monitorOf.get(m.reading_id)!);
      }
    }
  }

  // For a city average, hours when too few of the city's monitors reported are
  // left out, and the chart draws them as gaps. See CITY_MIN_REPORTING_SHARE.
  const minStations = await cityMinStations(supabase, params.get("city"));

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

  return ok(points, {
    pollutant,
    days,
    stations: ids.length,
    points: points.length,
    today: istToday(),
    // City averages only: the fewest reporting stations an hour needed.
    min_stations: minStations,
  });
}
