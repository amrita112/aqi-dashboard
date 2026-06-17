/**
 * Unit tests for the AQI utility functions.
 *
 * These functions map AQI numbers (0–500) to EPA categories, colors, and labels.
 * Tests focus on the *boundaries* between categories — those are where bugs
 * usually hide (e.g., is 50 "Good" or "Moderate"?).
 */

import { describe, it, expect } from "vitest";
import {
  getAqiCategory,
  getAqiColor,
  getAqiLabel,
  getAqiTextColor,
} from "./aqi-utils";

describe("getAqiCategory", () => {
  // Each tuple is [input AQI value, expected category label].
  // Boundary values (50/51, 100/101, etc.) verify the < / <= edges.
  const cases: Array<[number, string]> = [
    [0,   "Good"],
    [50,  "Good"],
    [51,  "Moderate"],
    [100, "Moderate"],
    [101, "Unhealthy for Sensitive Groups"],
    [150, "Unhealthy for Sensitive Groups"],
    [151, "Unhealthy"],
    [200, "Unhealthy"],
    [201, "Very Unhealthy"],
    [300, "Very Unhealthy"],
    [301, "Hazardous"],
    [500, "Hazardous"],
  ];

  it.each(cases)("AQI %i maps to %s", (value, label) => {
    expect(getAqiCategory(value).label).toBe(label);
  });

  it("falls back to Hazardous for out-of-range values (above 500)", () => {
    // Defensive: shouldn't happen with valid data, but the function should
    // still return *something* sensible rather than undefined.
    expect(getAqiCategory(999).label).toBe("Hazardous");
  });
});

describe("getAqiColor", () => {
  it("returns the EPA green for Good values", () => {
    expect(getAqiColor(25)).toBe("#00e400");
  });

  it("returns the EPA maroon for Hazardous values", () => {
    expect(getAqiColor(400)).toBe("#7e0023");
  });
});

describe("getAqiLabel", () => {
  it("returns the label string matching the category", () => {
    expect(getAqiLabel(75)).toBe("Moderate");
    expect(getAqiLabel(175)).toBe("Unhealthy");
  });
});

describe("getAqiTextColor", () => {
  // Light backgrounds (Good, Moderate, Unhealthy for Sensitive Groups) → black text.
  // Dark backgrounds (Unhealthy, Very Unhealthy, Hazardous) → white text.
  it("returns black for light-background categories", () => {
    expect(getAqiTextColor(25)).toBe("#000000");   // Good
    expect(getAqiTextColor(75)).toBe("#000000");   // Moderate
    expect(getAqiTextColor(125)).toBe("#000000");  // Unhealthy for Sensitive Groups
  });

  it("returns white for dark-background categories", () => {
    expect(getAqiTextColor(175)).toBe("#ffffff");  // Unhealthy
    expect(getAqiTextColor(250)).toBe("#ffffff");  // Very Unhealthy
    expect(getAqiTextColor(400)).toBe("#ffffff");  // Hazardous
  });
});
