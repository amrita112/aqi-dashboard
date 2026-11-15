/**
 * The app's AQI rule must agree exactly with the Python one, on the same
 * cases file. Completeness itself is the rollup's stored verdict
 * (readings_daily.is_complete); here the expected verdicts from the cases file
 * stand in for it.
 */
import { describe, it, expect } from "vitest";
import cases from "../fixtures/daily_quality/cases.json";
import { completeDays, meetsAqiRule, stationDayAqi, type DailyRow } from "@/lib/api/daily-quality";

const rows = (cases.rows as DailyRow[]).map((r, i) => ({ ...r, is_complete: cases.expected.complete[i] }));

describe("AQI rule, shared with scripts/ingest/lib/aqi_rule.py", () => {
  for (const rule of ["both_pm", "cpcb"] as const) {
    it(`builds the same AQI days under the ${rule} rule`, () => {
      expect(stationDayAqi(completeDays(rows), rule)).toEqual(cases.expected[`aqi_${rule}`]);
    });
  }

  it("needs both PMs by default", () => {
    expect(meetsAqiRule(["pm25", "pm10"])).toBe(true);
    expect(meetsAqiRule(["pm25", "no2", "so2"])).toBe(false);
    expect(meetsAqiRule(["pm25", "no2", "so2"], "cpcb")).toBe(true);
  });
});

describe("completeDays reads the rollup's flag", () => {
  it("keeps only rows flagged complete; unassessed (null) rows are left out", () => {
    const got = completeDays([
      { pollutant: "pm25", date: "2026-11-01", mean: 50, is_complete: true },
      { pollutant: "pm25", date: "2026-11-02", mean: 50, is_complete: false },
      { pollutant: "pm25", date: "2026-11-03", mean: 50, is_complete: null },
    ]);
    expect(got.map((r) => r.date)).toEqual(["2026-11-01"]);
  });
});
