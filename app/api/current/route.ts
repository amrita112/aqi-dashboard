/**
 * GET /api/current?lat=&lng=&k=      — averaged over the nearest stations
 * GET /api/current?monitor_id=       — one specific station
 *
 * The most recent reading for a place, and — just as important — how old it is.
 *
 * The age is not a footnote. OpenAQ publishes 17–24 hours behind and a station
 * can go quiet for a week, so "current" is a claim that has to be qualified
 * every time. `stale` and `age_hours` are part of the payload rather than
 * something a screen can forget to compute. When several stations are averaged
 * the age reported is the OLDEST of them: a blend is only as current as its
 * stalest input.
 *
 * This reads raw `readings`, not the daily rollup, because the point is
 * freshness. Raw is pruned at 30 days; older questions go to /api/history.
 */

import { createClient } from "@/lib/supabase/server";
import { ok, fail } from "@/lib/api/respond";
import { resolvePlace, placeMeta } from "@/lib/api/place";
import { getCurrent, averageCurrent } from "@/lib/api/data";
import { toIstLocalString, toIstClock, dataAgeDays } from "@/lib/api/time";
import { getAqiCategory, getAqiTextColor } from "@/lib/aqi-utils";
import { DEFAULT_SCALE } from "@/lib/types";

export const dynamic = "force-dynamic"; // freshness is the whole point

/** Past this, "current" is not an honest word for it. */
const STALE_AFTER_HOURS = 24;

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const supabase = createClient();

  const resolved = await resolvePlace(supabase, params);
  if ("error" in resolved) {
    return fail(resolved.error.message, resolved.error.status);
  }
  const { place } = resolved;

  const perStation = await Promise.all(
    place.monitors.map(async (monitor) => ({
      monitor,
      reading: await getCurrent(supabase, monitor),
    })),
  );

  const averaged = averageCurrent(perStation);
  if (!averaged) {
    return fail(
      "No readings held for any station near that place in the retention window",
      404,
    );
  }

  const { aqi, dominant_pollutant, age_hours, pollutants } = averaged.value;
  const category = getAqiCategory(aqi, DEFAULT_SCALE);

  // The freshest contributing reading, for the timestamp a screen shows.
  const freshest = perStation
    .map((p) => p.reading)
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .sort((a, b) => Date.parse(b.recorded_at) - Date.parse(a.recorded_at))[0];

  return ok(
    {
      aqi,
      band: {
        label: category.label,
        color: category.color,
        textColor: getAqiTextColor(aqi, DEFAULT_SCALE),
      },
      // Which pollutant drives the index surprises people: it is PM10 most of
      // the time in these cities, not PM2.5.
      dominant_pollutant,
      pollutants,
      recorded_at: freshest.recorded_at,
      recorded_local: toIstLocalString(freshest.recorded_at),
      recorded_clock: toIstClock(freshest.recorded_at),
      age_hours,
      age_days: dataAgeDays(freshest.recorded_at),
      stale: age_hours > STALE_AFTER_HOURS,
    },
    {
      ...placeMeta(place, averaged.stations),
      stale_after_hours: STALE_AFTER_HOURS,
      scale: DEFAULT_SCALE,
      // Stated because it is not the average: the blend is as old as its
      // stalest contributor.
      age_is: "oldest contributing station",
    },
  );
}
