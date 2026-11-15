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
import { nearestMonitors, pageAll, MEASURED_POLLUTANTS } from "@/lib/api/data";
import { completeDays, stationDayAqi, type DailyRow } from "@/lib/api/daily-quality";
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

  // POLLUTANT, because the map was AQI-only: someone who chose PM2.5 in setup
  // saw AQI dots everywhere, which is both the wrong number and a different
  // colour from the rest of their app.
  const pollutant = params.get("pollutant") ?? "aqi";
  if (pollutant !== "aqi" && pollutant !== "pm25") {
    return badRequest("pollutant must be aqi or pm25", { received: pollutant });
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

  // One query for every nearby station, rather than one query per station --
  // PAGED, because 80 stations x 14 days x 4 pollutants is ~4,500 rows and
  // PostgREST stops at 1,000. Unpaged, only the newest ~3 days survived, so
  // stations a few days behind showed as "no data", and a station could keep
  // only some of its pollutants on the cut-off day (audit §7.5).
  const { data, error } = await pageAll<DailyRow & { monitor_id: string }>((lo, hi) =>
    supabase
      .from("readings_daily")
      .select("monitor_id, pollutant, date, mean, is_complete")
      .in("monitor_id", monitors.map((m) => m.id))
      .in("pollutant", [...MEASURED_POLLUTANTS])
      .gte("date", from)
      .order("date", { ascending: false })
      .order("monitor_id", { ascending: true })
      .order("pollutant", { ascending: true })
      .range(lo, hi),
  );

  if (error) return fail("Could not load readings", 502, error);

  // COMPLETE days only: the rollup's stored verdict (readings_daily.is_complete),
  // the same one the forecast uses. Then each station's most recent day FOR THE
  // SELECTED MEASURE: its newest complete PM2.5 day, or its newest day that
  // qualifies for an AQI. Picking the newest day across all pollutants left a
  // PM2.5 dot empty whenever that day had no PM2.5 row (audit §6.4).
  const complete = completeDays(data);
  const latest = new Map<string, { date: string; sub: number; pollutant: string; raw: number | null }>();
  if (pollutant === "pm25") {
    // For PM2.5 the map shows the CONCENTRATION; the colour still comes from
    // its sub-index, so a dot means the same severity on both maps.
    for (const r of complete) {
      if (r.pollutant !== "pm25" || r.mean === null) continue;
      const have = latest.get(r.monitor_id);
      if (have && have.date >= r.date) continue;
      latest.set(r.monitor_id, {
        date: r.date, raw: r.mean, pollutant: "pm25",
        sub: computeSubIndex("pm25", r.mean, DEFAULT_SCALE),
      });
    }
  } else {
    for (const d of stationDayAqi(complete)) {
      const have = latest.get(d.monitor_id);
      if (have && have.date >= d.date) continue;
      latest.set(d.monitor_id, { date: d.date, sub: d.aqi, pollutant: d.dominant, raw: null });
    }
  }

  const stations = monitors.map((m) => {
    const day = latest.get(m.id);
    if (!day) {
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
    const category = getAqiCategory(day.sub, DEFAULT_SCALE);
    // `value` is what the dot shows; `aqi` stays the sub-index so the colour
    // and the band are on one scale whichever pollutant is selected.
    const shown = pollutant === "pm25" ? day.raw : day.sub;
    return {
      monitor_id: m.id, name: m.name, city: m.city,
      latitude: m.latitude, longitude: m.longitude,
      distance_km: m.distance_km,
      value: shown === null ? null : Math.round(shown),
      pollutant,
      aqi: day.sub,
      band: {
        label: category.label,
        color: category.color,
        textColor: getAqiTextColor(day.sub, DEFAULT_SCALE),
      },
      dominant_pollutant: day.pollutant,
      date: day.date,
      age_days: daysBetweenIst(day.date, today),
    };
  });

  const withData = stations.filter((s) => s.aqi !== null);
  return ok(stations, {
    lat, lng, radius_km: radiusKm, pollutant,
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
    reading_is: "most recent COMPLETE daily average (>= 16 hours of data), not a live reading",
  });
}
