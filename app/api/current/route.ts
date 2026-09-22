/**
 * GET /api/current?monitor_id=&pollutant=
 *
 * The most recent reading we hold for a station, and — just as important —
 * how old it is.
 *
 * The age is not a footnote. OpenAQ publishes 17–24 hours behind and a station
 * can go quiet for a week, so "current" is a claim that has to be qualified
 * every single time. A screen that shows a number without its age is lying by
 * omission, which is why `stale` and `age_hours` are part of the payload
 * rather than something a caller can forget to compute.
 *
 * This reads raw `readings`, not the daily rollup, because the point is
 * freshness. Raw is pruned at 30 days; older questions go to /api/history.
 */

import { createClient } from "@/lib/supabase/server";
import { ok, fail, notFound, badRequest, parseMonitorId } from "@/lib/api/respond";
import { toIstLocalString, toIstClock, dataAgeDays } from "@/lib/api/time";
import { getAqiCategory, getAqiTextColor, computeSubIndex } from "@/lib/aqi-utils";
import { DEFAULT_SCALE } from "@/lib/types";

export const dynamic = "force-dynamic"; // freshness is the whole point

/** Past this, "current" is not an honest word for it. */
const STALE_AFTER_HOURS = 24;

const MEASURED = ["pm25", "pm10", "no2", "so2"] as const;

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const monitorId = parseMonitorId(params);
  if (!monitorId) return badRequest("monitor_id is required and must be a UUID");

  const supabase = createClient();

  // Newest reading first; one row is enough to date the station.
  const { data: readings, error: rErr } = await supabase
    .from("readings")
    .select("id, recorded_at, created_at")
    .eq("monitor_id", monitorId)
    .order("recorded_at", { ascending: false })
    .limit(1);

  if (rErr) return fail("Could not load the latest reading", 502, rErr.message);
  if (!readings?.length) {
    return notFound("No readings held for this station in the retention window");
  }

  const reading = readings[0];
  const { data: measurements, error: mErr } = await supabase
    .from("measurements")
    .select("pollutant, value, unit")
    .eq("reading_id", reading.id);

  if (mErr) return fail("Could not load measurements", 502, mErr.message);

  const rows = (measurements ?? []).filter(
    (m) => (MEASURED as readonly string[]).includes(m.pollutant) && m.value >= 0,
  );
  if (!rows.length) {
    return notFound("The latest reading carries no usable measurements");
  }

  // Composite AQI is the MAX of the per-pollutant sub-indices, and which
  // pollutant wins is worth returning: it is PM10 most of the time in these
  // cities, which surprises people who assume AQI means PM2.5.
  const subIndices = rows.map((m) => ({
    pollutant: m.pollutant,
    value: m.value,
    unit: m.unit,
    sub_index: computeSubIndex(m.pollutant as never, m.value, DEFAULT_SCALE),
  }));
  const dominant = subIndices.reduce((a, b) => (b.sub_index > a.sub_index ? b : a));
  const aqi = dominant.sub_index;
  const category = getAqiCategory(aqi, DEFAULT_SCALE);

  const ageHours =
    (Date.now() - Date.parse(reading.recorded_at)) / 3_600_000;

  const requested = params.get("pollutant");
  const single = requested
    ? subIndices.find((s) => s.pollutant === requested) ?? null
    : null;
  if (requested && !single) {
    return notFound(`This station did not report ${requested} in its latest reading`);
  }

  return ok(
    {
      monitor_id: monitorId,
      recorded_at: reading.recorded_at,
      recorded_local: toIstLocalString(reading.recorded_at),
      recorded_clock: toIstClock(reading.recorded_at),
      age_hours: Math.round(ageHours * 10) / 10,
      age_days: dataAgeDays(reading.recorded_at),
      stale: ageHours > STALE_AFTER_HOURS,
      aqi,
      band: {
        label: category.label,
        color: category.color,
        textColor: getAqiTextColor(aqi, DEFAULT_SCALE),
      },
      dominant_pollutant: dominant.pollutant,
      pollutants: subIndices,
      requested: single,
    },
    { stale_after_hours: STALE_AFTER_HOURS, scale: DEFAULT_SCALE },
  );
}
