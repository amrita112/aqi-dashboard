/**
 * Averaging over the stations nearest a place.
 *
 * A person is at a place, not at a monitor. These pin the three decisions that
 * make that honest:
 *
 *   - a seasonal_normal station is dropped from the blend when a neighbour has
 *     a real forecast, because it carries no information about tomorrow
 *   - the reported age is the OLDEST contributor, not the average
 *   - per-day station counts survive, because uneven coverage is a fact the
 *     chart must be able to show
 */

import { describe, it, expect } from "vitest";
import { getAqiLabel } from "@/lib/aqi-utils";
import {
  averageForecastDays,
  averageCurrent,
  averageHistory,
  type NearbyMonitor,
  type CurrentReading,
  type HistoryPoint,
} from "@/lib/api/data";
import { indexShape, expandDay, type ForecastDailyRow, type ShapeRow } from "@/lib/api/forecast";

function monitor(id: string, km: number): NearbyMonitor {
  return {
    id,
    name: `Station ${id}`,
    city: "Delhi NCR",
    latitude: 28.6,
    longitude: 77.2,
    distance_km: km,
  };
}

const SHAPE = indexShape(
  Array.from({ length: 24 }, (_, hour) => ({
    city: "Delhi",
    pollutant: "aqi",
    month: 9,
    hour,
    ratio: 1 + 0.2 * Math.cos(((hour - 21) / 24) * 2 * Math.PI),
  })) as ShapeRow[],
);

function day(over: Partial<ForecastDailyRow> = {}) {
  const row: ForecastDailyRow = {
    monitor_id: "m",
    pollutant: "aqi",
    target_date: "2026-09-29",
    horizon_days: 1,
    value: 100,
    band_p50: 0.15,
    band_p80: 0.3,
    mode: "forecast",
    model: "blend",
    based_on_date: "2026-09-27",
    data_age_days: 2,
    ...over,
  };
  return expandDay(row, "Delhi", SHAPE);
}

describe("averageForecastDays", () => {
  it("averages the stations that have a real forecast", () => {
    const out = averageForecastDays(
      [
        { monitor: monitor("a", 1), days: [day({ value: 100 })] },
        { monitor: monitor("b", 2), days: [day({ value: 200 })] },
      ],
      1,
      "aqi",
    )!;
    expect(out.value[0].value).toBe(150);
    expect(out.stations).toHaveLength(2);
  });

  it("drops a seasonal_normal neighbour when a real forecast exists", () => {
    // The thin station carries only climatology. Blending it in would drag the
    // anomaly toward zero — the over-smoothing this pipeline spent a week
    // removing — so it is excluded rather than averaged.
    const out = averageForecastDays(
      [
        { monitor: monitor("real", 1), days: [day({ value: 100 })] },
        {
          monitor: monitor("thin", 2),
          days: [day({ value: 300, mode: "seasonal_normal", band_p50: null, band_p80: null })],
        },
      ],
      1,
      "aqi",
    )!;
    expect(out.value[0].value).toBe(100);
    expect(out.value[0].mode).toBe("forecast");
    expect(out.stations.map((s) => s.monitor_id)).toEqual(["real"]);
  });

  it("falls back to seasonal_normal, honestly labelled, when nobody nearby can forecast", () => {
    const sn = () => day({ value: 120, mode: "seasonal_normal", band_p50: null, band_p80: null });
    const out = averageForecastDays(
      [
        { monitor: monitor("a", 1), days: [sn()] },
        { monitor: monitor("b", 2), days: [sn()] },
      ],
      1,
      "aqi",
    )!;
    expect(out.value[0].mode).toBe("seasonal_normal");
    expect(out.value[0].value).toBe(120);
    expect(out.value[0].headline).toMatch(/typical for this time of year/i);
  });

  it("averages the hourly curves, not just the daily number", () => {
    const out = averageForecastDays(
      [
        { monitor: monitor("a", 1), days: [day({ value: 100 })] },
        { monitor: monitor("b", 2), days: [day({ value: 200 })] },
      ],
      1,
      "aqi",
    )!;
    const hourly = out.value[0].hourly!;
    expect(hourly).toHaveLength(24);
    // Each hour is the mean of the two stations' values at that hour.
    const mean = hourly.reduce((s, h) => s + h.value, 0) / 24;
    expect(mean).toBeCloseTo(150, 0);
  });

  it("orders contributing stations by distance", () => {
    const out = averageForecastDays(
      [
        { monitor: monitor("far", 9), days: [day()] },
        { monitor: monitor("near", 1), days: [day()] },
      ],
      1,
      "aqi",
    )!;
    expect(out.stations.map((s) => s.monitor_id)).toEqual(["near", "far"]);
  });

  it("returns null when no station has a forecast at all", () => {
    expect(averageForecastDays([{ monitor: monitor("a", 1), days: [] }], 1, "aqi")).toBeNull();
  });
});

describe("averageCurrent", () => {
  function reading(over: Partial<CurrentReading> = {}): CurrentReading {
    return {
      monitor_id: "m",
      station: "S",
      recorded_at: new Date().toISOString(),
      age_hours: 3,
      aqi: 100,
      dominant_pollutant: "pm10",
      pollutants: [{ pollutant: "pm25", value: 40, sub_index: 67 }],
      ...over,
    };
  }

  it("reports the OLDEST contributor's age, not the average", () => {
    // A blend is only as current as its stalest input; averaging 2h and 30h
    // into 16h would overstate how fresh the answer is.
    const out = averageCurrent([
      { monitor: monitor("a", 1), reading: reading({ age_hours: 2 }) },
      { monitor: monitor("b", 2), reading: reading({ age_hours: 30 }) },
    ])!;
    expect(out.value.age_hours).toBe(30);
  });

  it("averages AQI and picks the most common dominant pollutant", () => {
    const out = averageCurrent([
      { monitor: monitor("a", 1), reading: reading({ aqi: 100, dominant_pollutant: "pm10" }) },
      { monitor: monitor("b", 2), reading: reading({ aqi: 200, dominant_pollutant: "pm10" }) },
      { monitor: monitor("c", 3), reading: reading({ aqi: 150, dominant_pollutant: "pm25" }) },
    ])!;
    expect(out.value.aqi).toBe(150);
    expect(out.value.dominant_pollutant).toBe("pm10");
  });

  it("ignores stations holding no reading", () => {
    const out = averageCurrent([
      { monitor: monitor("a", 1), reading: reading({ aqi: 80 }) },
      { monitor: monitor("b", 2), reading: null },
    ])!;
    expect(out.value.aqi).toBe(80);
    expect(out.stations).toHaveLength(1);
  });

  it("returns null when nothing nearby has a reading", () => {
    expect(averageCurrent([{ monitor: monitor("a", 1), reading: null }])).toBeNull();
  });
});

describe("averageHistory", () => {
  function point(date: string, mean: number, over: Partial<HistoryPoint> = {}): HistoryPoint {
    return { date, mean, min: mean - 10, max: mean + 10, count: 84, source: "openaq", ...over };
  }

  it("averages date by date and records how many stations backed each day", () => {
    const out = averageHistory([
      { monitor: monitor("a", 1), series: [point("2026-09-20", 100), point("2026-09-21", 50)] },
      { monitor: monitor("b", 2), series: [point("2026-09-20", 200)] },
    ]);
    expect(out.value).toHaveLength(2);
    expect(out.value[0]).toMatchObject({ date: "2026-09-20", mean: 150, stations: 2 });
    // The 21st is backed by one station only, and says so.
    expect(out.value[1]).toMatchObject({ date: "2026-09-21", mean: 50, stations: 1 });
  });

  it("takes the extremes seen anywhere, not an average of extremes", () => {
    // Averaging the minima would understate how clean it actually got.
    const out = averageHistory([
      { monitor: monitor("a", 1), series: [point("2026-09-20", 100, { min: 20, max: 300 })] },
      { monitor: monitor("b", 2), series: [point("2026-09-20", 100, { min: 80, max: 120 })] },
    ]);
    expect(out.value[0].min).toBe(20);
    expect(out.value[0].max).toBe(300);
  });

  it("keeps dates sorted even when stations disagree on coverage", () => {
    const out = averageHistory([
      { monitor: monitor("a", 1), series: [point("2026-09-22", 10)] },
      { monitor: monitor("b", 2), series: [point("2026-09-20", 10), point("2026-09-21", 10)] },
    ]);
    expect(out.value.map((d) => d.date)).toEqual(["2026-09-20", "2026-09-21", "2026-09-22"]);
  });
});

describe("the averaged band describes the averaged value", () => {
  it("does not inherit the first station's band", () => {
    // The bug Amrita caught: a Bangalore forecast of 59 was labelled "Severe"
    // because `...base` carried the first contributing station's band through
    // while `value` was overwritten with the average.
    const out = averageForecastDays(
      [
        { monitor: monitor("a", 1), days: [day({ value: 450 })] },
        { monitor: monitor("b", 2), days: [day({ value: 50 })] },
      ],
      1,
      "aqi",
    )!;
    expect(out.value[0].value).toBeCloseTo(250, 0);
    expect(out.value[0].band.label).toBe("Poor");
  });

  it("gives each averaged hour its own band", () => {
    const out = averageForecastDays(
      [
        { monitor: monitor("a", 1), days: [day({ value: 400 })] },
        { monitor: monitor("b", 2), days: [day({ value: 40 })] },
      ],
      1,
      "aqi",
    )!;
    const hours = out.value[0].hourly ?? [];
    for (const h of hours) {
      expect(h.band.label).toBe(getAqiLabel(h.value));
    }
  });
});

describe("band lookup covers the gaps between bands", () => {
  it("does not report a fractional value as the worst band", () => {
    // The CPCB table is written as integer ranges — Good 0-50, Satisfactory
    // 51-100 — so 50.4 fell in the gap, matched nothing, and hit the
    // fall-back-to-worst branch. Values are continuous; the table is not.
    // The band follows the number the screen shows, which is the rounded one.
    expect(getAqiLabel(50.4)).toBe("Good");          // displays as 50
    expect(getAqiLabel(50.6)).toBe("Satisfactory");  // displays as 51
    expect(getAqiLabel(100.4)).toBe("Satisfactory");
    expect(getAqiLabel(200.4)).toBe("Moderate");
    expect(getAqiLabel(300.4)).toBe("Poor");
    expect(getAqiLabel(400.4)).toBe("Very Poor");
  });

  it("still reports genuinely severe values as Severe", () => {
    expect(getAqiLabel(401)).toBe("Severe");
    expect(getAqiLabel(999)).toBe("Severe");
    expect(getAqiLabel(5000)).toBe("Severe");
  });
});
