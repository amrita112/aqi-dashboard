/**
 * The time base, on the TypeScript side.
 *
 * Mirrors tests/test_time_base.py. Both sides must agree, because the Python
 * writes `readings_daily.date` and `diurnal_shape.hour` and the TypeScript
 * reads them — a divergence here is invisible until a chart is five and a half
 * hours out.
 */

import { describe, it, expect } from "vitest";
import {
  toIstDate,
  toIstHour,
  toIstClock,
  toIstLocalString,
  istDayBoundsUtc,
  daysBetweenIst,
  IST_OFFSET_MINUTES,
} from "@/lib/api/time";

describe("IST offset", () => {
  it("is five and a half hours", () => {
    expect(IST_OFFSET_MINUTES).toBe(330);
  });
});

describe("toIstDate", () => {
  it("keeps the same day when UTC midnight is 05:30 IST", () => {
    // This is why a UTC-day rollup looked plausible and was still wrong.
    expect(toIstDate("2026-09-15T00:00:00Z")).toBe("2026-09-15");
  });

  it("rolls to the next Indian day at 18:30 UTC", () => {
    expect(toIstDate("2026-09-15T18:29:59Z")).toBe("2026-09-15");
    expect(toIstDate("2026-09-15T18:30:00Z")).toBe("2026-09-16");
  });

  it("puts a late-evening UTC instant on the following Indian day", () => {
    // 20:00 UTC is 01:30 IST. A UTC-day rollup files this under the 15th;
    // a person in India lived it on the 16th.
    expect(toIstDate("2026-09-15T20:00:00Z")).toBe("2026-09-16");
  });

  it("handles a year boundary", () => {
    expect(toIstDate("2026-12-31T19:00:00Z")).toBe("2027-01-01");
  });
});

describe("toIstHour", () => {
  it("shifts a UTC hour into the Indian clock", () => {
    // The diurnal peak measured in our own readings is UTC 16, which is the
    // evening in India — the same moment the XKDR-fitted shape peaks at.
    expect(toIstHour("2026-09-15T16:00:00Z")).toBe(21);
    expect(toIstHour("2026-09-15T00:00:00Z")).toBe(5);
  });

  it("wraps past midnight", () => {
    expect(toIstHour("2026-09-15T19:00:00Z")).toBe(0);
  });
});

describe("display helpers", () => {
  it("renders a readable clock time", () => {
    // 16:00 UTC is 21:30 IST — the evening peak our own readings show.
    expect(toIstClock("2026-09-15T16:00:00Z")).toBe("9:30 pm");
    expect(toIstClock("2026-09-15T00:00:00Z")).toBe("5:30 am");
    // Midnight and noon are the two a 12-hour clock usually gets wrong.
    expect(toIstClock("2026-09-15T18:30:00Z")).toBe("12:00 am");
    expect(toIstClock("2026-09-15T06:30:00Z")).toBe("12:00 pm");
  });

  it("renders a local ISO-ish string without pretending it is UTC", () => {
    expect(toIstLocalString("2026-09-15T16:00:00Z")).toBe("2026-09-15T21:30");
  });
});

describe("istDayBoundsUtc", () => {
  it("starts an Indian day at 18:30 UTC the day before", () => {
    const { start, end } = istDayBoundsUtc("2026-09-15");
    expect(start).toBe("2026-09-14T18:30:00.000Z");
    expect(end).toBe("2026-09-15T18:30:00.000Z");
  });

  it("tiles consecutive days with no gap or overlap", () => {
    const first = istDayBoundsUtc("2026-09-15");
    const second = istDayBoundsUtc("2026-09-16");
    expect(first.end).toBe(second.start);
  });

  it("agrees with toIstDate about which day an instant belongs to", () => {
    const instant = "2026-09-15T20:00:00Z";
    const day = toIstDate(instant);
    const { start, end } = istDayBoundsUtc(day);
    expect(Date.parse(start)).toBeLessThanOrEqual(Date.parse(instant));
    expect(Date.parse(instant)).toBeLessThan(Date.parse(end));
  });

  it("makes every day exactly 24 hours (India has no daylight saving)", () => {
    for (const d of ["2026-01-01", "2026-03-29", "2026-10-25", "2024-02-29"]) {
      const { start, end } = istDayBoundsUtc(d);
      expect(Date.parse(end) - Date.parse(start)).toBe(86_400_000);
    }
  });
});

describe("daysBetweenIst", () => {
  it("counts calendar days, which is what data age means", () => {
    expect(daysBetweenIst("2026-09-15", "2026-09-18")).toBe(3);
    expect(daysBetweenIst("2026-09-15", "2026-09-15")).toBe(0);
  });

  it("crosses a month boundary", () => {
    expect(daysBetweenIst("2026-08-30", "2026-09-02")).toBe(3);
  });
});
