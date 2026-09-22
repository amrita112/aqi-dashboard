/**
 * Forecast assembly: daily value x diurnal shape -> hours a screen can draw.
 *
 * These are unit tests over fixed rows rather than tests against Supabase, so
 * they pin the arithmetic and the honesty rules without needing the network or
 * a populated database.
 */

import { describe, it, expect } from "vitest";
import {
  indexShape,
  expandDay,
  bestHour,
  type ForecastDailyRow,
  type ShapeRow,
} from "@/lib/api/forecast";

/** An evening-peaking shape, like Delhi's: low mid-afternoon, high at night. */
function eveningShape(city = "Delhi", pollutant = "aqi", month = 9): ShapeRow[] {
  return Array.from({ length: 24 }, (_, hour) => ({
    city,
    pollutant,
    month,
    hour,
    // Peaks at hour 21 IST, troughs twelve hours away at hour 9.
    ratio: 1 + 0.25 * Math.cos(((hour - 21) / 24) * 2 * Math.PI),
  }));
}

function row(over: Partial<ForecastDailyRow> = {}): ForecastDailyRow {
  return {
    monitor_id: "11111111-1111-1111-1111-111111111111",
    pollutant: "aqi",
    target_date: "2026-09-16",
    horizon_days: 1,
    value: 100,
    band_p50: 0.15,
    band_p80: 0.3,
    mode: "forecast",
    model: "blend",
    based_on_date: "2026-09-14",
    data_age_days: 2,
    ...over,
  };
}

describe("indexShape", () => {
  it("keys on city, pollutant and month", () => {
    const idx = indexShape(eveningShape());
    expect(idx.has("Delhi|aqi|9")).toBe(true);
    expect(idx.has("Delhi|aqi|11")).toBe(false);
  });

  it("defaults a missing hour to the day mean, not to zero", () => {
    // A thin cell must not silently forecast nothing for that hour.
    const partial: ShapeRow[] = [
      { city: "Delhi", pollutant: "aqi", month: 9, hour: 3, ratio: 0.8 },
    ];
    const ratios = indexShape(partial).get("Delhi|aqi|9")!;
    expect(ratios[3]).toBe(0.8);
    expect(ratios[10]).toBe(1);
  });
});

describe("expandDay", () => {
  const shape = indexShape(eveningShape());

  it("produces 24 hours whose mean is the daily value", () => {
    const day = expandDay(row(), "Delhi", shape);
    expect(day.hourly).toHaveLength(24);
    const mean =
      day.hourly!.reduce((s, h) => s + h.value, 0) / day.hourly!.length;
    // The shape is a ratio around 1, so spreading must not move the daily level.
    expect(mean).toBeCloseTo(100, 0);
  });

  it("labels hours in IST, matching the shape's own index", () => {
    const day = expandDay(row(), "Delhi", shape);
    expect(day.hourly![21].local_time).toBe("2026-09-16T21:00");
    // The peak must land where the shape says, not five hours away.
    const peak = day.hourly!.reduce((a, b) => (b.value > a.value ? b : a));
    expect(peak.hour).toBe(21);
  });

  it("turns the stored band ratio into absolute bounds", () => {
    const day = expandDay(row({ value: 200, band_p80: 0.25 }), "Delhi", shape);
    expect(day.band_low).toBeCloseTo(150, 1);
    expect(day.band_high).toBeCloseTo(250, 1);
  });

  it("carries no band on a seasonal_normal day", () => {
    // An average has no prediction interval; drawing one implies a forecast
    // we are not making.
    const day = expandDay(
      row({ mode: "seasonal_normal", band_p50: null, band_p80: null }),
      "Delhi",
      shape,
    );
    expect(day.band_low).toBeNull();
    expect(day.band_high).toBeNull();
    expect(day.hourly!.every((h) => h.band_low === null)).toBe(true);
  });

  it("gives seasonal_normal a headline that does not claim a forecast", () => {
    const day = expandDay(row({ mode: "seasonal_normal" }), "Delhi", shape);
    expect(day.headline).toMatch(/typical for this time of year/i);
    expect(day.headline).not.toMatch(/forecast/i);
  });

  it("distinguishes forecast from outlook in the headline", () => {
    expect(expandDay(row({ mode: "forecast" }), "Delhi", shape).headline)
      .toMatch(/^Forecast/);
    expect(expandDay(row({ mode: "outlook" }), "Delhi", shape).headline)
      .toMatch(/^Outlook/);
  });

  it("falls back to a flat day when the city-month has no shape, and says so", () => {
    const day = expandDay(row({ target_date: "2026-11-16" }), "Delhi", shape);
    expect(day.hourly_is_flat).toBe(true);
    expect(new Set(day.hourly!.map((h) => h.value)).size).toBe(1);
  });

  it("omits hours when asked to", () => {
    const day = expandDay(row(), "Delhi", shape, { hourly: false });
    expect(day.hourly).toBeNull();
  });

  it("bands a PM2.5 concentration by its sub-index, not as a raw AQI", () => {
    // 40 ug/m3 PM2.5 is not an AQI of 40. Getting this wrong would paint a
    // moderate day as good.
    const pm = expandDay(
      row({ pollutant: "pm25", value: 40 }),
      "Delhi",
      indexShape(eveningShape("Delhi", "pm25")),
    );
    const aqi = expandDay(row({ pollutant: "aqi", value: 40 }), "Delhi", shape);
    expect(pm.band.label).not.toBe(aqi.band.label);
  });
});

describe("bestHour", () => {
  const shape = indexShape(eveningShape());

  it("finds the cleanest hour of the day", () => {
    const day = expandDay(row(), "Delhi", shape);
    expect(bestHour(day)!.hour).toBe(9);
  });

  it("refuses to advise when the profile is flat", () => {
    // Every hour ties, so naming one would be inventing advice.
    const day = expandDay(row({ target_date: "2026-11-16" }), "Delhi", shape);
    expect(bestHour(day)).toBeNull();
  });
});
