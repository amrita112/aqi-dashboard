/**
 * The day's low and high, for forecasts further out than three days.
 *
 * Chirag asked for this and it went into the Trends tab and the AI's chart —
 * and NOT into the station card reached from the map, which carried on
 * drawing seven rises and falls in a box a few hundred pixels wide. A rule
 * applied in two places out of three is how two screens come to disagree
 * about what a week looks like.
 */

import { describe, it, expect } from "vitest";

/** The same reduction the station card and the Trends tab both perform. */
function dayRange(hourly: { value: number }[] | null, fallback: [number | null, number | null]) {
  const vs = (hourly ?? []).map((h) => h.value).filter((v) => Number.isFinite(v));
  return vs.length ? ([Math.min(...vs), Math.max(...vs)] as const) : fallback;
}

describe("dayRange", () => {
  it("takes the lowest and highest hour of the day", () => {
    const hours = [40, 55, 70, 62, 48].map((value) => ({ value }));
    expect(dayRange(hours, [null, null])).toEqual([40, 70]);
  });

  it("falls back to the forecast band when there is no hourly shape", () => {
    // Not every city and month has a fitted diurnal curve; the day still has
    // to draw something rather than vanishing.
    expect(dayRange(null, [30, 90])).toEqual([30, 90]);
    expect(dayRange([], [30, 90])).toEqual([30, 90]);
  });

  it("survives a day whose hours are all the same", () => {
    const flat = [50, 50, 50].map((value) => ({ value }));
    expect(dayRange(flat, [null, null])).toEqual([50, 50]);
  });

  it("ignores values that are not finite", () => {
    const messy = [{ value: 40 }, { value: NaN }, { value: 70 }];
    expect(dayRange(messy, [null, null])).toEqual([40, 70]);
  });
});
