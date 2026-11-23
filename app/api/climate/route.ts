/**
 * GET /api/climate?monitor_id=<uuid>&metric=aqi|pm25          one station
 * GET /api/climate?lat=&lng=[&k=&max_km=]&metric=...           a place
 * GET /api/climate?city=...[&lat=&lng=]&metric=...              a city average
 *
 * Historical trends: the yearly pattern, month by month, from every year of
 * history we hold (CPCB via XKDR from 2009, OpenAQ since Sep 2025). Every
 * place is resolved exactly as /api/history resolves it (resolvePlace in
 * lib/api/place.ts), so the same stations answer both charts: the nearest
 * few for a point, and EVERY active station in the city for a city average.
 *
 * Reads station_monthly_climate, a small table rebuilt monthly by
 * scripts/climate/build_station_climate.py, and combines the stations with
 * combineClimate (lib/api/climate.ts), where the rules are explained.
 *
 * Returns `data`: { months, years, n_years, first_year, last_year, sources,
 * monitor_ids, dropped } and `meta`: which stations answered, plus the thresholds used.
 */

import { createClient } from "@/lib/supabase/server";
import { ok, fail, badRequest } from "@/lib/api/respond";
import { resolvePlace, placeMeta } from "@/lib/api/place";
import { pageAll } from "@/lib/api/data";
import {
  combineClimate,
  DEFAULT_EXTREMES_RULE,
  DEFAULT_MIN_DAYS_PER_MONTH,
  DEFAULT_MIN_YEARS,
  SCREEN_FACTOR,
  SCREEN_MIN_REFERENCE_YEARS,
  SCREEN_MIN_YEARS,
  type ClimateRow,
} from "@/lib/api/climate";

// The table changes once a month, so a day's cache costs nothing in freshness
// and saves a database read on nearly every tap.
export const revalidate = 86400;
const CACHE_CONTROL = "public, s-maxage=86400, stale-while-revalidate=604800";

const ALLOWED_METRICS = new Set(["aqi", "pm25"]);

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;

  // `metric`, or `pollutant` as the other routes call it, so a screen can
  // reuse the query it already builds.
  const metric = params.get("metric") ?? params.get("pollutant") ?? "aqi";
  if (!ALLOWED_METRICS.has(metric)) {
    return badRequest("metric must be aqi or pm25", { received: metric });
  }

  const supabase = createClient();
  const resolved = await resolvePlace(supabase, params);
  if ("error" in resolved) return fail(resolved.error.message, resolved.error.status);
  const { place } = resolved;

  // WHICH STATIONS: whatever resolvePlace found -- the nearest few for a
  // point, every active station in the city for a city average.
  const monitors = place.monitors;
  const ids = monitors.map((m) => m.id);

  // City averages drop year-months with too few stations, like /api/history:
  // fewer than 10% OF THE SAME POOL (place.minStations; see resolveCity).
  // Taking 10% of all 79 Delhi stations while drawing on only 10 demanded 8
  // of those 10 at once, and left one year.
  const minStations = place.minStations;

  // Ordered on (monitor_id, year, month), unique within one metric, so pages
  // never overlap or skip. A whole city (Delhi NCR: 79 stations, ~5,500 rows
  // per measure) passes the 1000-row cap many times over; PostgREST would
  // otherwise cut it off silently.
  const { data, error } = await pageAll<ClimateRow>((lo, hi) =>
    supabase
      .from("station_monthly_climate")
      .select("monitor_id, year, month, n_days, mean_of_means, mean_of_mins, mean_of_maxes, sources")
      .in("monitor_id", ids)
      .eq("metric", metric)
      .order("monitor_id", { ascending: true })
      .order("year", { ascending: true })
      .order("month", { ascending: true })
      .range(lo, hi),
  );
  // A failed read is an error, not "no history here": the screen must not
  // tell someone their station has no past when the fault is ours.
  if (error) return fail("Could not load historical trends", 502, error);

  const result = combineClimate(data, { minStations });

  const contributing = monitors
    .filter((m) => result.monitor_ids.includes(m.id))
    .map((m) => ({ monitor_id: m.id, name: m.name, distance_km: m.distance_km }));

  const res = ok(result, {
    ...placeMeta(place, contributing),
    metric,
    min_days_per_month: DEFAULT_MIN_DAYS_PER_MONTH,
    min_years: DEFAULT_MIN_YEARS,
    extremes_rule: DEFAULT_EXTREMES_RULE,
    screen: { min_years: SCREEN_MIN_YEARS, min_reference_years: SCREEN_MIN_REFERENCE_YEARS, factor: SCREEN_FACTOR },
    min_stations: minStations,
    // "city" for a city average (always the city's whole network now).
    city_pool: place.kind === "city" ? "city" : null,
  });
  res.headers.set("Cache-Control", CACHE_CONTROL);
  return res;
}
