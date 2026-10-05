/**
 * When to tell someone tomorrow looks bad.
 *
 * Shared by the in-app banner and, later, the push sender, so these pin the
 * two rules that keep an alert honest:
 *
 *   - the threshold is compared against the forecast VALUE, because that is
 *     the number the user typed
 *   - a seasonal_normal day never raises an alert, because that figure is the
 *     long-run average for the date, not a prediction about tomorrow
 *
 * The second matters more than it sounds. Delhi's seasonal average sits above
 * a typical threshold for most of the winter, so treating it as a forecast
 * would fire the alarm nearly every day regardless of the air — and an alarm
 * that always fires is one people turn off.
 */

import { describe, it, expect } from "vitest";
import { decideAlert, type ForecastLike } from "@/lib/alerts";

function day(over: Partial<ForecastLike> = {}): ForecastLike {
  return {
    value: 400,
    mode: "forecast",
    target_date: "2026-10-06",
    band: { label: "Very Poor" },
    ...over,
  };
}

describe("opting out", () => {
  it("says nothing when the user chose not to be notified", () => {
    // null is the explicit choice from setup, not an unanswered question.
    expect(decideAlert(day(), null, "aqi")).toBeNull();
  });

  it("says nothing when there is no forecast", () => {
    expect(decideAlert(null, 100, "aqi")).toBeNull();
  });
});

describe("the threshold is a number, not a band", () => {
  it("fires one above the threshold", () => {
    expect(decideAlert(day({ value: 381 }), 380, "aqi")?.level).toBe("alert");
  });

  it("fires exactly at the threshold", () => {
    // "380 or above" is what the setup screen says.
    expect(decideAlert(day({ value: 380 }), 380, "aqi")?.level).toBe("alert");
  });

  it("stays quiet one below", () => {
    expect(decideAlert(day({ value: 379 }), 380, "aqi")).toBeNull();
  });

  it("ignores the band entirely", () => {
    // A Severe band under the user's threshold is still under it.
    const quiet = decideAlert(day({ value: 100, band: { label: "Severe" } }), 380, "aqi");
    expect(quiet).toBeNull();
    // And a Good band above a low threshold still fires.
    const loud = decideAlert(day({ value: 60, band: { label: "Good" } }), 50, "aqi");
    expect(loud?.level).toBe("alert");
  });
});

describe("a seasonal average is not a forecast", () => {
  it("never raises a full alert, however far above the threshold", () => {
    const d = decideAlert(day({ value: 450, mode: "seasonal_normal" }), 380, "aqi")!;
    expect(d.level).toBe("seasonal");
  });

  it("is never pushworthy", () => {
    // Delhi's seasonal average is above a typical threshold most of the
    // winter. Pushing on it would fire nearly every day regardless of the air.
    const d = decideAlert(day({ value: 450, mode: "seasonal_normal" }), 380, "aqi")!;
    expect(d.pushworthy).toBe(false);
    expect(decideAlert(day({ value: 450 }), 380, "aqi")!.pushworthy).toBe(true);
  });

  it("says in words that it is not a forecast", () => {
    const d = decideAlert(day({ mode: "seasonal_normal" }), 380, "aqi")!;
    expect(d.body).toMatch(/not a forecast/i);
    expect(d.body).toMatch(/no recent reading/i);
    expect(d.headline).not.toMatch(/forecast/i);
  });

  it("treats outlook as a real forecast, because it is one", () => {
    expect(decideAlert(day({ mode: "outlook" }), 380, "aqi")?.level).toBe("alert");
  });
});

describe("wording", () => {
  it("gives PM2.5 its unit and AQI none", () => {
    expect(decideAlert(day({ value: 300 }), 290, "pm25")!.body).toMatch(/µg\/m³/);
    expect(decideAlert(day({ value: 400 }), 380, "aqi")!.body).not.toMatch(/µg\/m³/);
  });

  it("quotes the threshold the user actually set", () => {
    const d = decideAlert(day({ value: 400 }), 380, "aqi")!;
    expect(d.headline).toContain("380");
    expect(d.threshold).toBe(380);
    expect(d.value).toBe(400);
  });

  it("rounds the displayed value rather than showing a decimal", () => {
    expect(decideAlert(day({ value: 192.84 }), 100, "aqi")!.value).toBe(193);
  });
});
