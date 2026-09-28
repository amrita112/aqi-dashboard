/**
 * GET /api/history?monitor_id=&pollutant=&days=&from=&to=
 *
 * The time-course screen. Daily statistics from `readings_daily`, which is the
 * compressed table — roughly 1/40th the size of the raw readings behind it and
 * the only place that reaches back past the 30-day raw retention.
 *
 * Two things this returns that a naive daily mean would hide:
 *
 *   `count` and `source` together. A day's `count` means different things by
 *   source — OpenAQ carries CPCB at 15-minute resolution so a complete day is
 *   ~96, while the XKDR historical export is HOURLY so a complete day is ~24.
 *   Reading `count` without `source` makes every historical day look
 *   three-quarters missing. `completeness` below does that arithmetic.
 *
 *   `min_ts` / `max_ts` converted to IST. They are stored as UTC instants and
 *   answer "when is the air cleanest here", which is a question about the
 *   Indian clock. Showing 18:00 when the person means 23:30 is the bug this
 *   conversion exists to prevent.
 */

import { createClient } from "@/lib/supabase/server";
import { ok, fail, badRequest, parseMonitorId, parseNumber } from "@/lib/api/respond";
import { istToday, toIstClock, toIstLocalString } from "@/lib/api/time";

export const revalidate = 600;

const ALLOWED_POLLUTANTS = new Set(["pm25", "pm10", "no2", "so2"]);

/**
 * Fallback readings-per-complete-day, by source, used only when a station has
 * too few days in the window to speak for itself.
 *
 * Migration 14 assumed OpenAQ always means 15-minute CPCB data, i.e. 96 a day.
 * Measured 2026-09-28, that is not what the stations do: 101 of ~150 top out at
 * exactly 84, nine report hourly (24), and the rest are scattered between. A
 * fixed denominator therefore reported complete days as 87% or 25% complete.
 * The station's own observed maximum is used instead, which self-calibrates to
 * whatever cadence it actually reports at.
 */
const FALLBACK_PER_DAY: Record<string, number> = { openaq: 84, xkdr: 24 };

/** Too few days to infer a cadence from; trust the source default instead. */
const MIN_DAYS_TO_INFER_CADENCE = 3;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;

  const monitorId = parseMonitorId(params);
  if (!monitorId) return badRequest("monitor_id is required and must be a UUID");

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
  const { data, error } = await supabase
    .from("readings_daily")
    .select("date, count, mean, min, min_ts, max, max_ts, p10, p50, p90, source")
    .eq("monitor_id", monitorId)
    .eq("pollutant", pollutant)
    .gte("date", from)
    .lte("date", to)
    .order("date", { ascending: true });

  if (error) return fail("Could not load history", 502, error.message);

  // A complete day is whatever this station manages at its best in the window.
  const rows = data ?? [];
  const bestBySource = new Map<string, number>();
  const daysBySource = new Map<string, number>();
  for (const d of rows) {
    bestBySource.set(d.source, Math.max(bestBySource.get(d.source) ?? 0, d.count));
    daysBySource.set(d.source, (daysBySource.get(d.source) ?? 0) + 1);
  }

  const series = rows.map((d) => {
    const observed = bestBySource.get(d.source) ?? 0;
    const enoughDays = (daysBySource.get(d.source) ?? 0) >= MIN_DAYS_TO_INFER_CADENCE;
    const expected = enoughDays && observed > 0 ? observed : FALLBACK_PER_DAY[d.source] ?? 84;
    return {
      date: d.date, // already an IST calendar day — see migration 15
      mean: d.mean,
      min: d.min,
      max: d.max,
      p10: d.p10,
      p50: d.p50,
      p90: d.p90,
      count: d.count,
      source: d.source,
      completeness: Math.min(1, Math.round((d.count / expected) * 100) / 100),
      readings_expected: expected,
      min_at: d.min_ts ? toIstLocalString(d.min_ts) : null,
      min_clock: d.min_ts ? toIstClock(d.min_ts) : null,
      max_at: d.max_ts ? toIstLocalString(d.max_ts) : null,
      max_clock: d.max_ts ? toIstClock(d.max_ts) : null,
    };
  });

  return ok(series, {
    monitor_id: monitorId,
    pollutant,
    from,
    to,
    days_returned: series.length,
    // How the completeness denominator was arrived at, so a screen showing
    // "90% complete" can say what it is 90% of.
    cadence_per_day: Object.fromEntries(bestBySource),
    // Gaps are normal — a station goes quiet, or the archive thins out — and a
    // screen should draw a break rather than a straight line through nothing.
    days_requested:
      Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1,
  });
}
