/**
 * The home-screen launch count: once per device per day, carrying only a
 * time-since-install bucket. The install date never leaves the phone.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { bucketFor, launchDetailForToday, stampInstallDate, LAUNCH_KEYS } from "@/lib/launch";
import { clearPrefs } from "@/lib/prefs";

// Noon IST on the given date, so the IST calendar day is unambiguous.
const at = (iso: string) => new Date(`${iso}T06:30:00Z`);

beforeEach(() => window.localStorage.clear());

describe("bucketFor", () => {
  it("puts days since install into four coarse buckets", () => {
    expect([0, 1, 7, 8, 30, 31, 400].map(bucketFor)).toEqual(
      ["d0", "d1_7", "d1_7", "d8_30", "d8_30", "d31_plus", "d31_plus"],
    );
  });
});

describe("launchDetailForToday", () => {
  it("measures from the install date when the install was seen", () => {
    stampInstallDate(at("2026-11-01"));
    expect(launchDetailForToday(at("2026-11-12"))).toBe("d8_30");
  });

  it("reports at most once per day", () => {
    stampInstallDate(at("2026-11-01"));
    expect(launchDetailForToday(at("2026-11-12"))).toBe("d8_30");
    expect(launchDetailForToday(at("2026-11-12"))).toBeNull();
    expect(launchDetailForToday(at("2026-11-13"))).toBe("d8_30");
  });

  it("falls back to the first home-screen open, marked seen_, without an install date", () => {
    expect(launchDetailForToday(at("2026-11-01"))).toBe("seen_d0");
    expect(launchDetailForToday(at("2026-11-20"))).toBe("seen_d8_30");
  });

  it("never stores anything but dates", () => {
    stampInstallDate(at("2026-11-01"));
    launchDetailForToday(at("2026-11-02"));
    for (const key of LAUNCH_KEYS) {
      const v = window.localStorage.getItem(key);
      if (v !== null) expect(v).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("is forgotten by Settings → Reset everything", () => {
    stampInstallDate(at("2026-11-01"));
    launchDetailForToday(at("2026-11-02"));
    clearPrefs();
    for (const key of LAUNCH_KEYS) expect(window.localStorage.getItem(key)).toBeNull();
  });
});
