/**
 * The notebook's Python copy of the serving layer must agree with the app.
 *
 * notebooks/forecast_verification.ipynb cannot run TypeScript, so it uses
 * scripts/forecast/serving_mirror.py, a line-for-line Python copy of
 * expandDay (lib/api/forecast.ts) and averageForecastDays (lib/api/data.ts).
 * This test runs the REAL TypeScript on the same cases file that
 * tests/test_serving_mirror.py runs the Python copy on. Both must produce the
 * `expected` values in the file exactly, so changing one side without the
 * other fails a test.
 *
 * Band colours/labels, computed_at and run_age_days are not mirrored (the
 * notebook does not score them), so they are removed before comparing.
 */
import { describe, it, expect } from "vitest";
import cases from "../fixtures/serving_mirror/cases.json";
import {
  expandDay,
  indexShape,
  type ForecastDailyRow,
  type ForecastDay,
  type ShapeRow,
} from "@/lib/api/forecast";
import { averageForecastDays, type NearbyMonitor } from "@/lib/api/data";

const shape = indexShape(cases.shape_rows as ShapeRow[]);

/** Drop the fields the Python mirror does not reproduce. */
function comparable(day: ForecastDay) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { band, computed_at, run_age_days, hourly, ...rest } = day;
  return {
    ...rest,
    hourly: hourly
      ? hourly.map((h) => {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { band: _b, ...hourRest } = h;
          return hourRest;
        })
      : null,
  };
}

describe("expandDay matches the Python mirror (serving_mirror.expand_day)", () => {
  for (const c of cases.expand_cases) {
    it(c.name, () => {
      const got = expandDay(c.row as ForecastDailyRow, c.city, shape, {
        hourly: true,
        today: c.today,
      });
      expect(comparable(got)).toEqual(c.expected);
    });
  }
});

describe("averageForecastDays matches the Python mirror (serving_mirror.average_forecast_days)", () => {
  for (const c of cases.average_cases) {
    it(c.name, () => {
      const perStation = c.stations.map((s) => ({
        // Only id, name and distance_km are read by averageForecastDays.
        monitor: { ...s.monitor, city: s.city, latitude: 0, longitude: 0 } as NearbyMonitor,
        days: (s.rows as ForecastDailyRow[]).map((r) =>
          expandDay(r, s.city, shape, { hourly: true, today: c.today }),
        ),
      }));
      const got = averageForecastDays(perStation, c.horizon_count, c.pollutant);
      const want = c.expected as { value: unknown[]; stations: unknown[] } | null;
      if (want === null) {
        expect(got).toBeNull();
        return;
      }
      expect(got).not.toBeNull();
      expect(got!.stations).toEqual(want.stations);
      expect(got!.value.map(comparable)).toEqual(want.value);
    });
  }
});
