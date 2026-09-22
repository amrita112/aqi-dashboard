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

/** Readings per complete day, by source. See migration 14. */
const EXPECTED_PER_DAY: Record<string, number> = { openaq: 96, xkdr: 24 };

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

  const series = (data ?? []).map((d) => {
    const expected = EXPECTED_PER_DAY[d.source] ?? 96;
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
    // Gaps are normal — a station goes quiet, or the archive thins out — and a
    // screen should draw a break rather than a straight line through nothing.
    days_requested:
      Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1,
  });
}
