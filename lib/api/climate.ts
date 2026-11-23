/**
 * Historical trends: the yearly pattern of a station or a place, month by month.
 *
 * The heavy lifting happens once a month in scripts/climate/build_station_climate.py,
 * which writes one row per (station, metric, year, month) into
 * station_monthly_climate: how many complete days the month had, and the
 * average of those days' mean, low and high. This file turns a handful of
 * those rows -- one station's, or the few stations around a place -- into what
 * the chart draws:
 *
 *   months  for each calendar month, across ALL years: the average daily
 *           mean, low and high, and how many years stand behind it
 *   years   one line per year: that year's monthly means, and how many
 *           stations each month rests on
 *
 * It is a pure function (no database), so the combining rules are tested
 * directly in tests/api/climate.test.ts.
 *
 * HOW SEVERAL STATIONS BECOME ONE PLACE (owner's decision, 23 Nov 2026):
 *
 *   mean  the plain mean of the stations' monthly means (every city figure in
 *         this project is a plain mean across stations)
 *   low   the mean of the stations' average daily lows
 *   high  the mean of the stations' average daily highs
 *
 *   Averaging keeps one odd station (Mumbai BKC reads 3-5x its neighbours)
 *   from setting the place's high on its own. NOTE: the "Past month" chart's
 *   averageHistory (lib/api/data.ts) takes the lowest low and highest high
 *   instead; it draws only the mean on screen, so the two charts' lines agree.
 *   Set DEFAULT_EXTREMES_RULE to "envelope" to use lowest/highest here too.
 *
 * ACROSS YEARS: the MEDIAN of the years, for the mean, low and high alike.
 * Every year counts once, so a year with three stations does not outweigh a
 * year with one; and the median, unlike the mean, is not dragged by one
 * strange year.
 *
 * UNUSUAL YEARS ARE SCREENED OUT FIRST, per station and calendar month (see
 * screenStationMonths). Colaba's September is the reason: six XKDR years read
 * 12-20 µg/m³ and the OpenAQ archive's Sep 2025 reads 309 -- an instrument or
 * data fault, not weather. The screen lives here rather than in the builder so
 * its thresholds can change without rebuilding the table.
 */

import { meanAcross } from "@/lib/api/data";

/** One row of station_monthly_climate, as the route reads it. */
export interface ClimateRow {
  monitor_id: string;
  year: number;
  month: number;
  n_days: number;
  mean_of_means: number;
  mean_of_mins: number;
  mean_of_maxes: number;
  sources: string;
}

/** How station lows/highs combine into a place's. See the file comment. */
export type ExtremesRule = "envelope" | "mean";

/**
 * A station-month needs at least this many complete days to count. A month
 * with three measured days says more about those three days than about the
 * month. Ten is a third of a month: enough to span the weather of more than
 * one week.
 */
export const DEFAULT_MIN_DAYS_PER_MONTH = 10;

/**
 * Months backed by fewer years than this are drawn greyed out. One year of
 * November is one November, not "what November is like" (about 10% of
 * station-months have a single year behind them).
 */
export const DEFAULT_MIN_YEARS = 2;

/** See the file comment: "mean" averages the stations' lows and highs. */
export const DEFAULT_EXTREMES_RULE: ExtremesRule = "mean";

/**
 * The unusual-year screen (screenStationMonths). A station's calendar month
 * (e.g. Colaba, every September) is screened only when it has at least
 * SCREEN_MIN_YEARS years; a year is left out when its monthly mean is at
 * least SCREEN_FACTOR times above, or below 1/SCREEN_FACTOR of, the average
 * of the station's OTHER (kept) years for that month; and only when at least
 * SCREEN_MIN_REFERENCE_YEARS years remain to judge it against. With fewer,
 * "unusual" has nothing solid to be unusual against, so every year is kept.
 */
export const SCREEN_MIN_YEARS = 5;
export const SCREEN_MIN_REFERENCE_YEARS = 4;
export const SCREEN_FACTOR = 3;

export interface ClimateOptions {
  minDaysPerMonth?: number;
  minYears?: number;
  extremes?: ExtremesRule;
  /**
   * City averages only: a year-month with fewer contributing stations is
   * left out, the same rule as the Past month chart (CITY_MIN_REPORTING_SHARE
   * in lib/api/place.ts). null for a station or a point.
   */
  minStations?: number | null;
  screenMinYears?: number;
  screenMinReferenceYears?: number;
  screenFactor?: number;
}

/** One station-year-month the screen left out. */
export interface DroppedStationMonth {
  monitor_id: string;
  year: number;
  month: number;
  mean: number;
  /** The average of the station's kept years for that month. */
  reference: number;
}

export interface ClimateMonth {
  /** 1 = January. */
  month: number;
  /** Average daily mean across years, or null when no year has this month. */
  mean: number | null;
  /** Average daily low across years. */
  min: number | null;
  /** Average daily high across years. */
  max: number | null;
  /** How many years stand behind this month. */
  n_years: number;
  /** False when n_years is below the minimum: the chart greys it out. */
  enough_years: boolean;
}

export interface ClimateYear {
  year: number;
  /** Distinct stations behind any month of this year. */
  stations: number;
  /** Twelve entries, January first; mean is null for a month with no data. */
  months: { month: number; mean: number | null; stations: number }[];
}

export interface ClimateResult {
  months: ClimateMonth[];
  years: ClimateYear[];
  /** Distinct years with at least one usable month. */
  n_years: number;
  first_year: number | null;
  last_year: number | null;
  /** Inputs the shown months came from, e.g. ["openaq_archive", "xkdr"]. */
  sources: string[];
  /** Stations that contributed at least one usable month. */
  monitor_ids: string[];
  /**
   * Station-months the unusual-year screen left out. They appear nowhere
   * else in the result (not in the summary, not in the per-year lines).
   */
  dropped: DroppedStationMonth[];
}

/** Median of a list, to 1 decimal place, or null when empty. */
export function median(values: number[]): number | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  const m = v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  return Math.round(m * 10) / 10;
}

/** True when `value` is at least `factor` times above or below `reference`. */
function farOff(value: number, reference: number, factor: number): boolean {
  if (!(reference > 0)) return false;
  const ratio = value / reference;
  return ratio >= factor || ratio <= 1 / factor;
}

/**
 * Leave out a station's unusual years, one calendar month at a time.
 *
 * Rows must already have enough days (DEFAULT_MIN_DAYS_PER_MONTH). For each
 * station and calendar month with at least `minYears` years:
 *
 *   1. Rank the years by how far they sit from the MEDIAN year (as a ratio,
 *      so 3x above and 3x below count alike). The median, because the plain
 *      average is exactly what a 309 among 14s corrupts.
 *   2. Try setting aside the k most distant years, largest k first, never
 *      leaving fewer than `minReference` years behind. The first k for which
 *      EVERY set-aside year is `factor` times off the AVERAGE of the years
 *      left -- the owner's rule, stated against the plain average of the
 *      other years -- is dropped.
 *   3. If no k works, or the month has too few years to leave `minReference`
 *      behind, every year is kept.
 *
 *   Why try several k rather than flag "anything 3x off the median": with
 *   two bad years among six, the median itself is pulled up, so a year that
 *   is 3x the other four can be only 2.7x the median and slip through.
 *
 * The owner's examples: 3 years, one 3x the rest -> all kept (fewer than 5).
 * 6 years, 2 of them 3x the other 4 -> those 2 dropped. 5 years, 2 of them 3x
 * the other 3 -> all kept (only 3 to judge against).
 */
export function screenStationMonths(
  rows: ClimateRow[],
  { minYears = SCREEN_MIN_YEARS, minReference = SCREEN_MIN_REFERENCE_YEARS, factor = SCREEN_FACTOR } = {},
): { kept: ClimateRow[]; dropped: DroppedStationMonth[] } {
  const groups = new Map<string, ClimateRow[]>();
  for (const r of rows) {
    const key = `${r.monitor_id}|${r.month}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const kept: ClimateRow[] = [];
  const dropped: DroppedStationMonth[] = [];
  groups.forEach((group) => {
    if (group.length < minYears) return void kept.push(...group);
    const typical = median(group.map((g) => g.mean_of_means));
    if (typical === null) return void kept.push(...group);
    // Distance from the typical year as a log-ratio (floored at 0.1 so a
    // zero cannot divide by zero).
    const dist = (v: number) => Math.abs(Math.log(Math.max(v, 0.1) / Math.max(typical, 0.1)));
    const ranked = [...group].sort((a, b) => dist(b.mean_of_means) - dist(a.mean_of_means));
    for (let k = group.length - minReference; k >= 1; k--) {
      const out = ranked.slice(0, k);
      const rest = ranked.slice(k);
      const reference = rest.reduce((t, g) => t + g.mean_of_means, 0) / rest.length;
      if (out.every((o) => farOff(o.mean_of_means, reference, factor))) {
        for (const o of out) {
          dropped.push({
            monitor_id: o.monitor_id,
            year: o.year,
            month: o.month,
            mean: o.mean_of_means,
            reference: Math.round(reference * 10) / 10,
          });
        }
        kept.push(...rest);
        return;
      }
    }
    kept.push(...group);
  });
  return { kept, dropped };
}

/** Lowest / highest of a list, or the mean, by rule. */
function combineExtreme(values: number[], rule: ExtremesRule, pick: "min" | "max"): number | null {
  if (!values.length) return null;
  if (rule === "mean") return meanAcross(values);
  return pick === "min" ? Math.min(...values) : Math.max(...values);
}

/**
 * Station-month rows -> the place's all-years months and per-year lines.
 *
 * `rows` may hold one station (the Map tab) or several (a place); they must
 * all be for one metric.
 */
export function combineClimate(rows: ClimateRow[], opts: ClimateOptions = {}): ClimateResult {
  const minDays = opts.minDaysPerMonth ?? DEFAULT_MIN_DAYS_PER_MONTH;
  const minYears = opts.minYears ?? DEFAULT_MIN_YEARS;
  const rule = opts.extremes ?? DEFAULT_EXTREMES_RULE;
  const minStations = opts.minStations ?? null;

  // 0. Enough days, then the unusual-year screen, station by station.
  const { kept, dropped } = screenStationMonths(
    rows.filter((r) => r.n_days >= minDays),
    {
      minYears: opts.screenMinYears ?? SCREEN_MIN_YEARS,
      minReference: opts.screenMinReferenceYears ?? SCREEN_MIN_REFERENCE_YEARS,
      factor: opts.screenFactor ?? SCREEN_FACTOR,
    },
  );

  // 1. Each (year, month): combine the stations.
  const byYearMonth = new Map<string, ClimateRow[]>();
  for (const r of kept) {
    const key = `${r.year}-${r.month}`;
    byYearMonth.set(key, [...(byYearMonth.get(key) ?? []), r]);
  }

  type Cell = { year: number; month: number; mean: number; min: number; max: number; stations: string[]; sources: string[] };
  const cells: Cell[] = [];
  byYearMonth.forEach((group) => {
    if (minStations !== null && group.length < minStations) return;
    const mean = meanAcross(group.map((g) => g.mean_of_means));
    const min = combineExtreme(group.map((g) => g.mean_of_mins), rule, "min");
    const max = combineExtreme(group.map((g) => g.mean_of_maxes), rule, "max");
    if (mean === null || min === null || max === null) return;
    cells.push({
      year: group[0].year,
      month: group[0].month,
      mean,
      min,
      max,
      stations: group.map((g) => g.monitor_id),
      sources: group.flatMap((g) => g.sources.split(",").filter(Boolean)),
    });
  });

  // 2. Across years, month by month: the median, every year counted once.
  const months: ClimateMonth[] = [];
  for (let month = 1; month <= 12; month++) {
    const these = cells.filter((c) => c.month === month);
    months.push({
      month,
      mean: median(these.map((c) => c.mean)),
      min: median(these.map((c) => c.min)),
      max: median(these.map((c) => c.max)),
      n_years: these.length,
      enough_years: these.length >= minYears,
    });
  }

  // 3. One line per year.
  const yearList = Array.from(new Set(cells.map((c) => c.year))).sort((a, b) => a - b);
  const years: ClimateYear[] = yearList.map((year) => {
    const these = cells.filter((c) => c.year === year);
    return {
      year,
      stations: new Set(these.flatMap((c) => c.stations)).size,
      months: Array.from({ length: 12 }, (_, i) => {
        const c = these.find((x) => x.month === i + 1);
        return { month: i + 1, mean: c?.mean ?? null, stations: c?.stations.length ?? 0 };
      }),
    };
  });

  return {
    months,
    years,
    n_years: yearList.length,
    first_year: yearList[0] ?? null,
    last_year: yearList[yearList.length - 1] ?? null,
    sources: Array.from(new Set(cells.flatMap((c) => c.sources))).sort(),
    monitor_ids: Array.from(new Set(cells.flatMap((c) => c.stations))).sort(),
    dropped: dropped.sort((a, b) => a.monitor_id.localeCompare(b.monitor_id) || a.month - b.month || a.year - b.year),
  };
}
