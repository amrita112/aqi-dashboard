/**
 * GET /api/history?lat=&lng=&k=&pollutant=&days=   — averaged over a location
 * GET /api/history?monitor_id=...                   — one station
 *
 * The time-course screen. Daily statistics from `readings_daily`, the
 * compressed table — roughly 1/40th the size of the raw readings behind it and
 * the only place that reaches past the 30-day raw retention.
 *
 * Averaged over the nearest stations so the chart describes the person's
 * neighbourhood rather than whichever monitor happened to be picked.
 *
 * Three things this returns that a naive daily mean would hide:
 *
 *   `stations` per day. Coverage is uneven — monitors go quiet, the archive
 *   thins out — and a day backed by one station is a different claim from one
 *   backed by three. A chart that hides that draws a smooth line through a gap.
 *
 *   `completeness` against the station's OWN cadence. Migration 14 assumed
 *   OpenAQ always means 15-minute data (96/day); measured on 2026-09-28 most
 *   stations top out at 84 and nine report hourly, so a fixed denominator made
 *   complete days look broken.
 *
 *   `min_ts` / `max_ts` converted to IST. They are stored as UTC instants and
 *   answer "when is the air cleanest here", which is a question about the
 *   Indian clock. Showing 18:00 when the person means 23:30 is the bug this
 *   conversion exists to prevent.
 */

import { createClient } from "@/lib/supabase/server";
import { ok, fail, badRequest, parseNumber } from "@/lib/api/respond";
import { resolvePlace, placeMeta } from "@/lib/api/place";
import { getHistory, averageHistory } from "@/lib/api/data";
import { istToday, toIstClock, toIstLocalString } from "@/lib/api/time";

export const revalidate = 600;

// "aqi" is derived rather than stored -- readings_daily holds only the four
// measured pollutants, and composite AQI is the max of their sub-indices. See
// getHistoryAqi(). Without it, the app's default measurement has no history.
const ALLOWED_POLLUTANTS = new Set(["aqi", "pm25", "pm10", "no2", "so2"]);

// A derived AQI day sums `count` across the four pollutants behind it, so a
// complete day holds roughly four times the readings of a single-pollutant one.
// Without this the completeness figure would read about 400%.
const HISTORY_POLLUTANT_MULTIPLIER: Record<string, number> = { aqi: 4 };

/**
 * Fallback readings-per-complete-day, by source, used only when a station has
 * too few days in the window to speak for itself. See the note above.
 */
const FALLBACK_PER_DAY: Record<string, number> = { openaq: 84, xkdr: 24 };

/** Too few days to infer a cadence from; trust the source default instead. */
const MIN_DAYS_TO_INFER_CADENCE = 3;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;

  const pollutant = params.get("pollutant") ?? "pm25";
  if (!ALLOWED_POLLUTANTS.has(pollutant)) {
    return badRequest(
      `pollutant must be one of: ${Array.from(ALLOWED_POLLUTANTS).join(", ")}`,
      { received: pollutant },
    );
  }

  const to = params.get("to") ?? istToday();
  if (!DATE_RE.test(to)) return badRequest("to must be YYYY-MM-DD");

  let from = params.get("from");
  if (from && !DATE_RE.test(from)) return badRequest("from must be YYYY-MM-DD");
  if (!from) {
    const days = parseNumber(params, "days", 30, 1, 3650);
    from = new Date(Date.parse(`${to}T00:00:00Z`) - days * 86_400_000)
      .toISOString()
      .slice(0, 10);
  }
  if (from > to) return badRequest("from must not be after to");

  const supabase = createClient();
  const resolved = await resolvePlace(supabase, params);
  if ("error" in resolved) return fail(resolved.error.message, resolved.error.status);
  const { place } = resolved;

  const perStation = await Promise.all(
    place.monitors.map(async (monitor) => ({
      monitor,
      series: await getHistory(supabase, monitor, pollutant, from!, to),
    })),
  );

  const averaged = averageHistory(perStation);

  // A complete day is whatever the neighbourhood manages at its best, summed
  // across however many stations contributed to that day.
  const perDayPerStation = averaged.value.map((d) => d.count / Math.max(1, d.stations));
  const observed = perDayPerStation.length ? Math.max(...perDayPerStation) : 0;
  const source = averaged.value[0]?.source ?? "openaq";
  const enoughDays = averaged.value.length >= MIN_DAYS_TO_INFER_CADENCE;
  const multiplier = HISTORY_POLLUTANT_MULTIPLIER[pollutant] ?? 1;
  const expectedPerStation =
    enoughDays && observed > 0
      ? Math.round(observed)
      : (FALLBACK_PER_DAY[source] ?? 84) * multiplier;

  // Per-station extremes and their timestamps are only meaningful for a single
  // station; across a neighbourhood the clock times would be from different
  // monitors on different days.
  const single = place.kind === "station" ? perStation[0]?.series ?? [] : [];
  const tsByDate = new Map(single.map((d) => [d.date, d]));

  const series = averaged.value.map((d) => {
    const raw = tsByDate.get(d.date) as
      | { min_ts?: string | null; max_ts?: string | null }
      | undefined;
    return {
      date: d.date, // already an IST calendar day — see migration 15
      mean: d.mean,
      min: d.min,
      max: d.max,
      stations: d.stations,
      count: d.count,
      source: d.source,
      readings_expected: expectedPerStation * d.stations,
      completeness: Math.min(
        1,
        Math.round((d.count / Math.max(1, expectedPerStation * d.stations)) * 100) / 100,
      ),
      min_at: raw?.min_ts ? toIstLocalString(raw.min_ts) : null,
      min_clock: raw?.min_ts ? toIstClock(raw.min_ts) : null,
      max_at: raw?.max_ts ? toIstLocalString(raw.max_ts) : null,
      max_clock: raw?.max_ts ? toIstClock(raw.max_ts) : null,
    };
  });

  return ok(series, {
    ...placeMeta(place, averaged.stations),
    pollutant,
    from,
    to,
    days_returned: series.length,
    days_requested:
      Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1,
    // How the completeness denominator was arrived at, so a screen showing
    // "90% complete" can say what it is 90% of.
    cadence_per_station_per_day: expectedPerStation,
    // Extreme timestamps are single-station only; across a neighbourhood they
    // would come from different monitors and mean nothing together.
    extremes_available: place.kind === "station",
  });
}
