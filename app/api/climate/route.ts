/**
 * GET /api/climate?monitor_id=<uuid>&metric=aqi|pm25          one station
 * GET /api/climate?lat=&lng=[&k=&max_km=&city=]&metric=...     a place
 *
 * Historical trends: the yearly pattern, month by month, from every year of
 * history we hold (CPCB via XKDR from 2009, OpenAQ since Sep 2025). The place
 * is resolved exactly as /api/history resolves it (lib/api/place.ts), so the
 * same nearest stations answer both charts.
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
import { resolvePlace, placeMeta, cityMinStations } from "@/lib/api/place";
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
  const ids = place.monitors.map((m) => m.id);

  // Ordered on (monitor_id, year, month), unique within one metric, so pages
  // never overlap or skip. A city of 10 stations x 15 years x 12 months can
  // pass 1000 rows, which PostgREST would otherwise cut off silently.
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

  // City averages drop year-months with too few stations, like /api/history.
  const minStations = await cityMinStations(supabase, params.get("city"));
  const result = combineClimate(data, { minStations });

  const contributing = place.monitors
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
  });
  res.headers.set("Cache-Control", CACHE_CONTROL);
  return res;
}
