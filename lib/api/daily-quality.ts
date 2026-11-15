/**
 * Which station-days the app shows, and when a day has an AQI.
 *
 * COMPLETENESS IS DECIDED ONCE, by the nightly rollup, and stored in
 * readings_daily.is_complete (migration 25; the rule is in
 * scripts/forecast/daily_quality.py, its numbers in
 * lib/daily-quality-config.json): >= 16 hours of readings and a plausible
 * mean. The app only reads that flag -- it does not re-derive it.
 *
 * What IS computed here is the AQI rule, because it combines a station's
 * pollutants on one day: by default a day's AQI needs complete PM2.5 AND PM10
 * (see the config's "aqi_rule"). The same cases file
 * (tests/fixtures/daily_quality/cases.json) tests this and the Python.
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
  count?: number | null;
  source?: string | null;
  /** The rollup's verdict. NULL (not yet assessed) is treated as incomplete. */
  is_complete?: boolean | null;
}

type RuleName = keyof typeof config.aqi_rules;
export const DEFAULT_AQI_RULE = config.aqi_rule as RuleName;

/** Only the days the rollup marked complete. */
export function completeDays<T extends DailyRow>(rows: T[]): T[] {
  return rows.filter((r) => r.is_complete === true && typeof r.mean === "number");
}

/** Does this set of pollutants carry enough for an AQI? Same rule as Python's aqi_rule.meets_aqi_rule. */
export function meetsAqiRule(pollutants: Iterable<string>, rule: RuleName = DEFAULT_AQI_RULE): boolean {
  const spec = config.aqi_rules[rule];
  const have = new Set(pollutants);
  if (have.size < spec.min_pollutants) return false;
  if (!spec.required_all.every((p) => have.has(p))) return false;
  if (spec.required_any.length && !spec.required_any.some((p) => have.has(p))) return false;
  return true;
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
    if (!meetsAqiRule(have, rule)) return;
    let dominant = have[0];
    subs.forEach((v, p) => {
      if (v > (subs.get(dominant) ?? -Infinity)) dominant = p;
    });
    out.push({ monitor_id, date, aqi: subs.get(dominant)!, dominant });
  });
  return out.sort((a, b) => a.monitor_id.localeCompare(b.monitor_id) || a.date.localeCompare(b.date));
}
