/**
 * Which station-days are complete enough to show, in the app's own charts.
 *
 * The TypeScript twin of scripts/forecast/daily_quality.py. Both read their
 * numbers from lib/daily-quality-config.json, and both are tested against the
 * same cases (tests/fixtures/daily_quality/cases.json), so the forecast and the
 * history, map and Home screens apply one rule:
 *
 *   1. A pollutant's day counts only with >= 16 hours of readings (CPCB's
 *      rule for a 24-hour average). The station's cadence -- hourly or every
 *      15 minutes -- is inferred from its typical day: the 90th percentile of
 *      its daily counts.
 *   2. Daily means outside 0-2000 µg/m³ are instrument faults.
 *   3. A day's AQI needs the pollutants the configured AQI rule requires
 *      (default: both PM2.5 and PM10).
 *
 * Before Nov 2026 the app drew a day from a single 15-minute reading as if it
 * were a full day (audit §1.2, §4.2-4.3).
 */

import config from "@/lib/daily-quality-config.json";
import { computeSubIndex } from "@/lib/aqi-utils";
import { DEFAULT_SCALE } from "@/lib/types";

export interface DailyRow {
  monitor_id?: string;
  pollutant: string;
  date: string;
  mean: number | null;
  count: number | null;
  source?: string | null;
}

type RuleName = keyof typeof config.aqi_rules;
export const DEFAULT_AQI_RULE = config.aqi_rule as RuleName;

/** Linear-interpolation quantile, the same definition pandas uses. */
function quantile(values: number[], q: number): number {
  const s = [...values].sort((a, b) => a - b);
  if (!s.length) return NaN;
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

function cadenceKey(r: DailyRow): string {
  return `${r.monitor_id ?? ""}|${r.pollutant}|${r.source ?? ""}`;
}

/** True for each row that is a complete, plausible day (rules 1 and 2). */
export function completeMask(rows: DailyRow[]): boolean[] {
  const counts = new Map<string, number[]>();
  for (const r of rows) {
    if (typeof r.count !== "number") continue;
    const k = cadenceKey(r);
    counts.set(k, [...(counts.get(k) ?? []), r.count]);
  }
  const needed = new Map<string, number>();
  counts.forEach((cs, k) => {
    const typical = quantile(cs, config.cadence_quantile);
    const perDay =
      typical > config.cadence_split ? config.readings_per_day_15min : config.readings_per_day_hourly;
    needed.set(k, (perDay * config.min_hours_for_complete_day) / 24);
  });
  return rows.map((r) => {
    const need = needed.get(cadenceKey(r));
    return (
      typeof r.count === "number" &&
      need !== undefined &&
      r.count >= need &&
      typeof r.mean === "number" &&
      r.mean >= config.valid_min &&
      r.mean <= config.valid_max
    );
  });
}

export function completeDays<T extends DailyRow>(rows: T[]): T[] {
  const mask = completeMask(rows);
  return rows.filter((_, i) => mask[i]);
}

export interface AqiDay {
  monitor_id: string;
  date: string;
  aqi: number;
  dominant: string;
}

/**
 * Composite AQI per (monitor, date) from rows that are ALREADY complete:
 * the max sub-index, only on days that meet the AQI rule (rule 3).
 */
export function stationDayAqi(complete: DailyRow[], rule: RuleName = DEFAULT_AQI_RULE): AqiDay[] {
  const spec = config.aqi_rules[rule];
  const byDay = new Map<string, { monitor_id: string; date: string; subs: Map<string, number> }>();
  for (const r of complete) {
    if (typeof r.mean !== "number") continue;
    const key = `${r.monitor_id ?? ""}|${r.date}`;
    const slot = byDay.get(key) ?? { monitor_id: r.monitor_id ?? "", date: r.date, subs: new Map() };
    slot.subs.set(r.pollutant, computeSubIndex(r.pollutant as never, r.mean, DEFAULT_SCALE));
    byDay.set(key, slot);
  }
  const out: AqiDay[] = [];
  byDay.forEach(({ monitor_id, date, subs }) => {
    const have = Array.from(subs.keys());
    if (have.length < spec.min_pollutants) return;
    if (!spec.required_all.every((p) => subs.has(p))) return;
    if (spec.required_any.length && !spec.required_any.some((p) => subs.has(p))) return;
    let dominant = have[0];
    subs.forEach((v, p) => {
      if (v > (subs.get(dominant) ?? -Infinity)) dominant = p;
    });
    out.push({ monitor_id, date, aqi: subs.get(dominant)!, dominant });
  });
  return out.sort((a, b) => a.monitor_id.localeCompare(b.monitor_id) || a.date.localeCompare(b.date));
}
