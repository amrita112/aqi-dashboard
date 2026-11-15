/**
 * Turning the stored forecast into something a screen can render directly.
 *
 * The database holds a DAILY number per station-pollutant plus a separate
 * per-city diurnal shape. The app shows hours. Rather than make every screen
 * multiply those together — and get the time base wrong in four places — that
 * happens here, once.
 *
 *     forecast(day, hour) = daily_forecast(day) x shape(city, month, hour)
 *
 * `diurnal_shape.hour` is an **IST** hour. It is fitted from the XKDR export,
 * whose timestamps are naive Indian local time. Looking it up by a UTC hour
 * rotates the whole profile by 5h30m — that was a live bug until 2026-09-22.
 * Everything below is IST end to end.
 *
 * The `mode` column is carried through untouched and screens must respect it:
 *
 *   forecast         show it as a forecast
 *   outlook          show it with a wider band and softer language
 *   seasonal_normal  say "typical for this time of year", NOT a prediction
 *
 * A station whose freshest reading is days old gets `seasonal_normal`, and
 * dressing that up as a forecast is the one thing this pipeline is built to
 * avoid.
 */

import { getAqiCategory, getAqiTextColor, computeSubIndex } from "@/lib/aqi-utils";
import { daysBetweenIst, istToday, toIstDate } from "@/lib/api/time";
import type { Scale } from "@/lib/types";
import { DEFAULT_SCALE } from "@/lib/types";

export type ForecastMode = "forecast" | "outlook" | "seasonal_normal";

export interface ForecastDailyRow {
  monitor_id: string;
  pollutant: string;
  target_date: string;
  horizon_days: number;
  value: number;
  band_p50: number | null;
  band_p80: number | null;
  mode: ForecastMode;
  model: string;
  based_on_date: string | null;
  data_age_days: number | null;
  /** When the nightly job wrote this row. Absent in older callers/tests. */
  computed_at?: string | null;
}

export interface ShapeRow {
  city: string;
  pollutant: string;
  month: number;
  hour: number;
  ratio: number;
}

export interface HourlyPoint {
  hour: number;
  /** `2026-09-16T14:00` in IST. */
  local_time: string;
  value: number;
  band_low: number | null;
  band_high: number | null;
  band: { label: string; color: string; textColor: string };
}

export interface ForecastDay {
  target_date: string;
  horizon_days: number;
  value: number;
  band_low: number | null;
  band_high: number | null;
  mode: ForecastMode;
  /** Plain-language framing that matches `mode`, so screens cannot drift. */
  headline: string;
  model: string;
  based_on_date: string | null;
  /**
   * Age of the reading behind this forecast, in IST days, counted to TODAY --
   * not to the night the row was computed. If the nightly job has not run for
   * a few days, the reading really is that much older, and saying otherwise
   * would understate how stale the forecast is (audit §7.8).
   */
  data_age_days: number | null;
  /** When the nightly job computed this row, and how many IST days ago that was. */
  computed_at: string | null;
  run_age_days: number | null;
  band: { label: string; color: string; textColor: string };
  hourly: HourlyPoint[] | null;
  /** True when no fitted shape existed for this city-month; hours are flat. */
  hourly_is_flat: boolean;
}

/** (city, pollutant, month) -> 24 ratios indexed by IST hour. */
export function indexShape(rows: ShapeRow[]): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const r of rows) {
    const key = `${r.city}|${r.pollutant}|${r.month}`;
    let arr = out.get(key);
    if (!arr) {
      // A thin cell is a missing ratio, not a zero: default to the day mean.
      arr = new Array(24).fill(1);
      out.set(key, arr);
    }
    if (r.hour >= 0 && r.hour < 24) arr[r.hour] = r.ratio;
  }
  return out;
}

/** The band a value falls in, for whichever pollutant it is. */
export function bandFor(pollutant: string, value: number, scale: Scale) {
  // AQI is already an index. A concentration has to be converted to its
  // sub-index first, or a PM2.5 of 40 would be read as an AQI of 40.
  const index =
    pollutant === "aqi" ? value : computeSubIndex(pollutant as never, value, scale);
  const cat = getAqiCategory(index, scale);
  return { label: cat.label, color: cat.color, textColor: getAqiTextColor(index, scale) };
}

/**
 * `daysAhead` is counted from TODAY, not from the night the row was computed.
 * horizon_days is relative to the run date, so today's row (yesterday's
 * horizon-1 row) used to be headed "Forecast for tomorrow" (audit §7.9).
 */
function headlineFor(mode: ForecastMode, daysAhead: number): string {
  if (mode === "seasonal_normal") {
    // The word "forecast" must not appear here. This card exists precisely
    // because there is no recent reading to predict from, and borrowing the
    // word would undo the distinction the mode column is drawn to make.
    return "Typical for this time of year — no recent reading to predict from";
  }
  const word = mode === "outlook" ? "Outlook" : "Forecast";
  if (daysAhead <= 0) return `${word} for today`;
  if (daysAhead === 1) return `${word} for tomorrow`;
  return `${word}, ${daysAhead} days ahead`;
}

/**
 * Expand one stored daily row into a display-ready day, with hours attached.
 *
 * Bands are stored as RATIOS of the forecast, not widths, so one number works
 * at Delhi's 200 and Bengaluru's 30. They are turned into absolute low/high
 * here. `seasonal_normal` rows carry no band by design — an average has no
 * prediction interval, and drawing one implies a forecast we are not making.
 */
export function expandDay(
  row: ForecastDailyRow,
  city: string,
  shape: Map<string, number[]>,
  opts: { hourly: boolean; scale?: Scale; today?: string } = { hourly: true },
): ForecastDay {
  const scale = opts.scale ?? DEFAULT_SCALE;
  const today = opts.today ?? istToday();
  const daysAhead = daysBetweenIst(today, row.target_date);
  const computedAt = row.computed_at ?? null;
  const runAge = computedAt ? daysBetweenIst(toIstDate(computedAt), today) : null;
  const dataAge = row.based_on_date
    ? daysBetweenIst(row.based_on_date, today)
    : row.data_age_days;
  const month = Number(row.target_date.slice(5, 7));
  const key = `${city}|${row.pollutant}|${month}`;
  const ratios = shape.get(key);

  const bandLow = row.band_p80 === null ? null : round1(row.value * (1 - row.band_p80));
  const bandHigh = row.band_p80 === null ? null : round1(row.value * (1 + row.band_p80));

  let hourly: HourlyPoint[] | null = null;
  if (opts.hourly) {
    hourly = Array.from({ length: 24 }, (_, hour) => {
      const v = round1(row.value * (ratios ? ratios[hour] : 1));
      return {
        hour,
        local_time: `${row.target_date}T${String(hour).padStart(2, "0")}:00`,
        value: v,
        band_low: row.band_p80 === null ? null : round1(v * (1 - row.band_p80)),
        band_high: row.band_p80 === null ? null : round1(v * (1 + row.band_p80)),
        band: bandFor(row.pollutant, v, scale),
      };
    });
  }

  return {
    target_date: row.target_date,
    horizon_days: row.horizon_days,
    value: round1(row.value),
    band_low: bandLow,
    band_high: bandHigh,
    mode: row.mode,
    headline: headlineFor(row.mode, daysAhead),
    model: row.model,
    based_on_date: row.based_on_date,
    data_age_days: dataAge,
    computed_at: computedAt,
    run_age_days: runAge,
    band: bandFor(row.pollutant, row.value, scale),
    hourly,
    hourly_is_flat: !ratios,
  };
}

/**
 * The cleanest hour of a forecast day, for "when should I go out?".
 *
 * Returns null when the hourly profile is flat, because with no fitted shape
 * every hour ties and picking one would be inventing advice.
 */
export function bestHour(day: ForecastDay): HourlyPoint | null {
  if (!day.hourly || day.hourly_is_flat) return null;
  return day.hourly.reduce((a, b) => (b.value < a.value ? b : a));
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
