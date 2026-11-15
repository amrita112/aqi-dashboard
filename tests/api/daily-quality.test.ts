/**
 * The app's completeness rule must agree exactly with the forecast's Python
 * one. Both are checked against the same cases file.
 */
import { describe, it, expect } from "vitest";
import cases from "../fixtures/daily_quality/cases.json";
import { completeMask, completeDays, stationDayAqi, type DailyRow } from "@/lib/api/daily-quality";

const rows = cases.rows as DailyRow[];

describe("daily completeness rule, shared with scripts/forecast/daily_quality.py", () => {
  it("marks the same rows complete as the Python implementation", () => {
    expect(completeMask(rows)).toEqual(cases.expected.complete);
  });

  for (const rule of ["both_pm", "cpcb"] as const) {
    it(`builds the same AQI days under the ${rule} rule`, () => {
      const got = stationDayAqi(completeDays(rows), rule);
      expect(got).toEqual(cases.expected[`aqi_${rule}`]);
    });
  }
});
