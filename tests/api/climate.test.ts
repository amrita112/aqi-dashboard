/**
 * Historical trends: how station-month rows combine into a place's yearly
 * pattern (lib/api/climate.ts). Small hand-made rows so every expected number
 * can be checked by eye.
 */
import { describe, it, expect } from "vitest";
import { combineClimate, median, screenStationMonths, type ClimateRow } from "@/lib/api/climate";

/** One station-month with sensible defaults. */
function row(over: Partial<ClimateRow> & Pick<ClimateRow, "monitor_id" | "year" | "month">): ClimateRow {
  return {
    n_days: 25,
    mean_of_means: 100,
    mean_of_mins: 50,
    mean_of_maxes: 200,
    sources: "xkdr",
    ...over,
  };
}

describe("combineClimate", () => {
  it("one station: each month is the mean of its years, every year once", () => {
    const r = combineClimate([
      row({ monitor_id: "a", year: 2023, month: 11, mean_of_means: 200, mean_of_mins: 100, mean_of_maxes: 400 }),
      row({ monitor_id: "a", year: 2024, month: 11, mean_of_means: 300, mean_of_mins: 150, mean_of_maxes: 500 }),
    ]);
    const nov = r.months[10];
    expect(nov).toMatchObject({ month: 11, mean: 250, min: 125, max: 450, n_years: 2, enough_years: true });
    expect(r.months[0]).toMatchObject({ month: 1, mean: null, n_years: 0, enough_years: false });
    expect(r.n_years).toBe(2);
    expect([r.first_year, r.last_year]).toEqual([2023, 2024]);
  });

  it("several stations: lows and highs are averaged, like the means", () => {
    const r = combineClimate(
      [
        row({ monitor_id: "a", year: 2024, month: 7, mean_of_means: 40, mean_of_mins: 20, mean_of_maxes: 80 }),
        row({ monitor_id: "b", year: 2024, month: 7, mean_of_means: 60, mean_of_mins: 30, mean_of_maxes: 120 }),
      ],
      { minYears: 1 },
    );
    expect(r.months[6]).toMatchObject({ mean: 50, min: 25, max: 100, n_years: 1 });
    expect(r.years[0]).toMatchObject({ year: 2024, stations: 2 });
    expect(r.years[0].months[6]).toEqual({ month: 7, mean: 50, stations: 2 });
  });

  it("the 'envelope' rule takes the lowest low and highest high instead", () => {
    const r = combineClimate(
      [
        row({ monitor_id: "a", year: 2024, month: 7, mean_of_mins: 20, mean_of_maxes: 80 }),
        row({ monitor_id: "b", year: 2024, month: 7, mean_of_mins: 30, mean_of_maxes: 120 }),
      ],
      { extremes: "envelope" },
    );
    expect(r.months[6]).toMatchObject({ min: 20, max: 120 });
  });

  it("drops station-months with too few complete days", () => {
    const r = combineClimate([
      row({ monitor_id: "a", year: 2024, month: 3, n_days: 9, mean_of_means: 999 }),
      row({ monitor_id: "b", year: 2024, month: 3, n_days: 10, mean_of_means: 80 }),
    ]);
    expect(r.months[2].mean).toBe(80);
    expect(r.monitor_ids).toEqual(["b"]);
  });

  it("greys months with fewer than the minimum years", () => {
    const r = combineClimate([row({ monitor_id: "a", year: 2025, month: 5 })]);
    expect(r.months[4]).toMatchObject({ n_years: 1, enough_years: false, mean: 100 });
  });

  it("city averages: year-months with too few stations are left out", () => {
    const r = combineClimate(
      [
        row({ monitor_id: "a", year: 2015, month: 1, mean_of_means: 500 }), // one station only
        row({ monitor_id: "a", year: 2024, month: 1, mean_of_means: 200 }),
        row({ monitor_id: "b", year: 2024, month: 1, mean_of_means: 300 }),
      ],
      { minStations: 2 },
    );
    expect(r.months[0]).toMatchObject({ mean: 250, n_years: 1 });
    expect(r.years.map((y) => y.year)).toEqual([2024]);
  });

  it("a year that has more stations does not outweigh a thin one", () => {
    const r = combineClimate([
      row({ monitor_id: "a", year: 2023, month: 12, mean_of_means: 100 }),
      row({ monitor_id: "a", year: 2024, month: 12, mean_of_means: 300 }),
      row({ monitor_id: "b", year: 2024, month: 12, mean_of_means: 300 }),
      row({ monitor_id: "c", year: 2024, month: 12, mean_of_means: 300 }),
    ]);
    // 2023 = 100, 2024 = 300 -> 200, not (100 + 300*3) / 4 = 250.
    expect(r.months[11].mean).toBe(200);
  });

  it("per-year lines have twelve months with nulls where nothing was measured", () => {
    const r = combineClimate([row({ monitor_id: "a", year: 2024, month: 2 })]);
    expect(r.years[0].months).toHaveLength(12);
    expect(r.years[0].months.filter((m) => m.mean !== null)).toHaveLength(1);
  });

  it("reports the inputs behind the shown months", () => {
    const r = combineClimate([
      row({ monitor_id: "a", year: 2025, month: 9, sources: "openaq_archive,xkdr" }),
      row({ monitor_id: "a", year: 2026, month: 9, sources: "openaq" }),
    ]);
    expect(r.sources).toEqual(["openaq", "openaq_archive", "xkdr"]);
  });

  it("no rows: an empty but well-formed answer", () => {
    const r = combineClimate([]);
    expect(r.months).toHaveLength(12);
    expect(r.years).toEqual([]);
    expect(r.n_years).toBe(0);
    expect(r.first_year).toBeNull();
  });

  it("across years it is the median, not the mean", () => {
    const r = combineClimate([
      row({ monitor_id: "a", year: 2022, month: 9, mean_of_means: 10, mean_of_mins: 5, mean_of_maxes: 20 }),
      row({ monitor_id: "a", year: 2023, month: 9, mean_of_means: 12, mean_of_mins: 6, mean_of_maxes: 24 }),
      row({ monitor_id: "a", year: 2024, month: 9, mean_of_means: 90, mean_of_mins: 70, mean_of_maxes: 150 }),
    ]);
    // Three years: below the screen's minimum, so 90 stays in -- but the
    // median ignores it where the mean (37.3) would not.
    expect(r.months[8]).toMatchObject({ mean: 12, min: 6, max: 24, n_years: 3 });
    expect(r.dropped).toEqual([]);
  });

  it("median helper", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

/** One station's same calendar month across years, with the given means. */
function years(means: number[], month = 9): ClimateRow[] {
  return means.map((m, i) => row({ monitor_id: "colaba", year: 2015 + i, month, mean_of_means: m }));
}

describe("unusual-year screen (owner's examples)", () => {
  it("3 years, one 3x the other two -> keep all (fewer than 5 years)", () => {
    const { kept, dropped } = screenStationMonths(years([10, 10, 30]));
    expect(kept).toHaveLength(3);
    expect(dropped).toEqual([]);
  });

  it("6 years, 2 of them 3x the average of the other 4 -> drop those 2", () => {
    const { kept, dropped } = screenStationMonths(years([10, 12, 11, 9, 31.5, 40]));
    expect(kept.map((k) => k.mean_of_means).sort((a, b) => a - b)).toEqual([9, 10, 11, 12]);
    expect(dropped.map((d) => d.mean).sort((a, b) => a - b)).toEqual([31.5, 40]);
    expect(dropped[0].reference).toBe(10.5);
  });

  it("5 years, 2 of them 3x the average of the other 3 -> keep all (only 3 to judge against)", () => {
    const { kept, dropped } = screenStationMonths(years([10, 10, 10, 30, 30]));
    expect(kept).toHaveLength(5);
    expect(dropped).toEqual([]);
  });

  it("screens low years too (1/3 or below), and exactly 3x counts", () => {
    const { dropped } = screenStationMonths(years([30, 30, 30, 30, 10]));
    expect(dropped.map((d) => d.mean)).toEqual([10]);
  });

  it("each station and calendar month is screened on its own", () => {
    const rows = [...years([10, 10, 10, 10, 40], 9), ...years([40, 40, 40, 40, 40], 10)];
    const { dropped } = screenStationMonths(rows);
    expect(dropped.map((d) => [d.month, d.mean])).toEqual([[9, 40]]);
  });

  it("Colaba-like September: the faulty year is left out of the summary and the year lines", () => {
    const r = combineClimate(years([12, 20, 12, 13, 14, 14, 309]));
    expect(r.dropped).toHaveLength(1);
    expect(r.dropped[0]).toMatchObject({ year: 2021, mean: 309 });
    expect(r.months[8]).toMatchObject({ mean: 13.5, n_years: 6 });
    expect(r.years.find((y) => y.year === 2021)).toBeUndefined();
  });
});
