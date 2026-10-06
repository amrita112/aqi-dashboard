/**
 * GET /api/map?lat=&lng=&radius_km=&limit=
 *
 * Every station near a point, each with its most recent daily reading, in ONE
 * round trip.
 *
 * The obvious implementation — call /api/current once per station — would be
 * seventy requests to draw one Delhi map. Instead this takes a single
 * readings_daily query covering every nearby station at once and reduces it in
 * memory.
 *
 * It reports the most recent DAILY value rather than the latest raw reading,
 * which is a deliberate trade. Raw would be fresher for the handful of
 * stations that report live, but it would need a query per station, and for
 * the government monitors — which publish days late — "latest raw" and "latest
 * daily" are the same day anyway.
 *
 * Every station comes back, including ones with no recent data. A map that
 * silently drops the quiet monitors makes coverage look better than it is, and
 * where the gaps are is a thing worth seeing.
 */

import { createClient } from "@/lib/supabase/server";
import { ok, fail, badRequest, parseNumber } from "@/lib/api/respond";
import { nearestMonitors, MEASURED_POLLUTANTS } from "@/lib/api/data";
import { getAqiCategory, getAqiTextColor, computeSubIndex } from "@/lib/aqi-utils";
import { DEFAULT_SCALE } from "@/lib/types";
import { istToday, daysBetweenIst } from "@/lib/api/time";

export const revalidate = 600;

/** How far back to look for a station's most recent day. */
const LOOKBACK_DAYS = 14;

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const lat = Number(params.get("lat"));
  const lng = Number(params.get("lng"));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return badRequest("lat and lng are required");
  }

  const radiusKm = parseNumber(params, "radius_km", 30, 1, 200);
  const limit = parseNumber(params, "limit", 60, 1, 200);

  const supabase = createClient();
  const monitors = await nearestMonitors(supabase, lat, lng, limit, radiusKm, params.get("city"));
  if (!monitors.length) {
    return fail(`No stations within ${radiusKm} km of that point.`, 404);
  }

  const today = istToday();
  const from = new Date(Date.parse(`${today}T00:00:00Z`) - LOOKBACK_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);

  // One query for every nearby station, rather than one query per station.
  const { data, error } = await supabase
    .from("readings_daily")
    .select("monitor_id, pollutant, date, mean")
    .in("monitor_id", monitors.map((m) => m.id))
    .in("pollutant", [...MEASURED_POLLUTANTS])
    .gte("date", from)
    .order("date", { ascending: false });

  if (error) return fail("Could not load readings", 502, error.message);

  const rows = (data ?? []) as unknown as {
    monitor_id: string; pollutant: string; date: string; mean: number | null;
  }[];

  // Keep only each station's most recent day, then take the max sub-index
  // across the pollutants it reported THAT day — composite AQI as CPCB defines
  // it. Mixing days would invent an AQI that never occurred.
  const latestDay = new Map<string, string>();
  for (const r of rows) {
    if (!latestDay.has(r.monitor_id)) latestDay.set(r.monitor_id, r.date);
  }
  const subIndices = new Map<string, { sub: number; pollutant: string }[]>();
  for (const r of rows) {
    if (r.date !== latestDay.get(r.monitor_id) || r.mean === null || r.mean < 0) continue;
    const list = subIndices.get(r.monitor_id) ?? [];
    list.push({
      sub: computeSubIndex(r.pollutant as Parameters<typeof computeSubIndex>[0], r.mean, DEFAULT_SCALE),
      pollutant: r.pollutant,
    });
    subIndices.set(r.monitor_id, list);
  }

  const stations = monitors.map((m) => {
    const subs = subIndices.get(m.id);
    const date = latestDay.get(m.id) ?? null;
    if (!subs?.length || !date) {
      // Returned anyway, with aqi null. Dropping it would make the map look
      // better covered than the network actually is.
      return {
        monitor_id: m.id, name: m.name, city: m.city,
        latitude: m.latitude, longitude: m.longitude,
        distance_km: m.distance_km,
        aqi: null, band: null, dominant_pollutant: null,
        date: null, age_days: null,
      };
    }
    const dominant = subs.reduce((a, b) => (b.sub > a.sub ? b : a));
    const category = getAqiCategory(dominant.sub, DEFAULT_SCALE);
    return {
      monitor_id: m.id, name: m.name, city: m.city,
      latitude: m.latitude, longitude: m.longitude,
      distance_km: m.distance_km,
      aqi: dominant.sub,
      band: {
        label: category.label,
        color: category.color,
        textColor: getAqiTextColor(dominant.sub, DEFAULT_SCALE),
      },
      dominant_pollutant: dominant.pollutant,
      date,
      age_days: daysBetweenIst(date, today),
    };
  });

  const withData = stations.filter((s) => s.aqi !== null);
  return ok(stations, {
    lat, lng, radius_km: radiusKm,
    station_count: stations.length,
    with_recent_data: withData.length,
    // Said plainly, because a map of coloured dots invites the assumption that
    // every dot is current.
    median_age_days: withData.length
      ? withData.map((s) => s.age_days as number).sort((a, b) => a - b)[
          Math.floor(withData.length / 2)
        ]
      : null,
    lookback_days: LOOKBACK_DAYS,
    reading_is: "most recent daily average, not a live reading",
  });
}
