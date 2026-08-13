/**
 * Unit tests for the AQI utility functions.
 *
 * The default scale is NAQI (India CPCB), so the bulk of tests cover NAQI
 * boundaries. EPA gets a smaller "still works via explicit scale arg" set.
 * Sub-index and composite-AQI tests use published reference values so it's
 * easy to eyeball against the CPCB breakpoint table.
 */

import { describe, it, expect } from "vitest";
import {
  getAqiCategory,
  getAqiColor,
  getAqiLabel,
  getAqiTextColor,
  computeSubIndex,
  computeAqiFromMeasurements,
  convertToCanonical,
} from "./aqi-utils";

describe("getAqiCategory (default = NAQI)", () => {
  const cases: Array<[number, string]> = [
    [0,   "Good"],
    [50,  "Good"],
    [51,  "Satisfactory"],
    [100, "Satisfactory"],
    [101, "Moderate"],
    [200, "Moderate"],
    [201, "Poor"],
    [300, "Poor"],
    [301, "Very Poor"],
    [400, "Very Poor"],
    [401, "Severe"],
    [500, "Severe"],
  ];

  it.each(cases)("NAQI AQI %i maps to %s", (value, label) => {
    expect(getAqiCategory(value).label).toBe(label);
  });

  it("falls back to Severe for out-of-range values (above 1000)", () => {
    expect(getAqiCategory(9999).label).toBe("Severe");
  });
});

describe("getAqiCategory with EPA scale", () => {
  const cases: Array<[number, string]> = [
    [50,  "Good"],
    [75,  "Moderate"],
    [125, "Unhealthy for Sensitive Groups"],
    [175, "Unhealthy"],
    [250, "Very Unhealthy"],
    [400, "Hazardous"],
  ];

  it.each(cases)("EPA AQI %i maps to %s", (value, label) => {
    expect(getAqiCategory(value, "epa").label).toBe(label);
  });
});

describe("getAqiColor", () => {
  it("returns NAQI dark green for Good (default scale)", () => {
    expect(getAqiColor(25)).toBe("#00b050");
  });

  it("returns NAQI light green for Satisfactory", () => {
    expect(getAqiColor(75)).toBe("#92d050");
  });

  it("returns NAQI maroon for Severe", () => {
    expect(getAqiColor(450)).toBe("#7e0023");
  });

  it("returns EPA colors when scale='epa'", () => {
    expect(getAqiColor(25,  "epa")).toBe("#00e400"); // EPA Good (brighter green)
    expect(getAqiColor(75,  "epa")).toBe("#ffff00"); // EPA Moderate (yellow)
    expect(getAqiColor(400, "epa")).toBe("#7e0023"); // EPA Hazardous
  });
});

describe("getAqiLabel", () => {
  it("returns the NAQI label matching the category (default)", () => {
    expect(getAqiLabel(75)).toBe("Satisfactory");
    expect(getAqiLabel(175)).toBe("Moderate");
  });

  it("returns EPA labels when scale='epa'", () => {
    expect(getAqiLabel(75,  "epa")).toBe("Moderate");
    expect(getAqiLabel(175, "epa")).toBe("Unhealthy");
  });
});

describe("getAqiTextColor", () => {
  // NAQI: light backgrounds = Good, Satisfactory, Moderate → black text
  //       dark backgrounds  = Poor, Very Poor, Severe    → white text
  it("returns black for light-background NAQI categories", () => {
    expect(getAqiTextColor(25)).toBe("#000000");   // Good
    expect(getAqiTextColor(75)).toBe("#000000");   // Satisfactory
    expect(getAqiTextColor(150)).toBe("#000000");  // Moderate
  });

  it("returns white for dark-background NAQI categories", () => {
    expect(getAqiTextColor(250)).toBe("#ffffff");  // Poor
    expect(getAqiTextColor(350)).toBe("#ffffff");  // Very Poor
    expect(getAqiTextColor(450)).toBe("#ffffff");  // Severe
  });

  it("uses EPA dark-label list when scale='epa'", () => {
    // AQI 250 is "Poor" (NAQI, dark) but "Very Unhealthy" (EPA, also dark).
    expect(getAqiTextColor(250, "epa")).toBe("#ffffff");
    // AQI 125 is "Moderate" (NAQI, light) but "USG" (EPA, light — orange bg).
    expect(getAqiTextColor(125, "epa")).toBe("#000000");
  });
});

describe("computeSubIndex (NAQI, default scale)", () => {
  // Reference values from the CPCB NAQI breakpoint table:
  //   pm25 = 30 → 50 (Good boundary)
  //   pm25 = 60 → 100 (Satisfactory boundary)
  //   pm25 = 90 → 200 (Moderate boundary)
  //   pm25 = 120 → 300 (Poor boundary)
  //   pm25 = 250 → 400 (Very Poor boundary)
  it("returns exact boundary values for PM2.5", () => {
    expect(computeSubIndex("pm25", 30)).toBe(50);
    expect(computeSubIndex("pm25", 60)).toBe(100);
    expect(computeSubIndex("pm25", 90)).toBe(200);
    expect(computeSubIndex("pm25", 120)).toBe(300);
    expect(computeSubIndex("pm25", 250)).toBe(400);
  });

  it("interpolates linearly inside a band for PM2.5", () => {
    // Mid-Satisfactory band (30–60 → 51–100):
    // value=45 → 51 + (49/30)*15 = 51 + 24.5 = 75.5 → 76
    expect(computeSubIndex("pm25", 45)).toBe(76);
    // Mid-Moderate band (60–90 → 101–200):
    // value=75 → 101 + (99/30)*15 = 101 + 49.5 = 150.5 → 151
    expect(computeSubIndex("pm25", 75)).toBe(151);
  });

  it("extrapolates linearly above the top band, capped at 1000", () => {
    expect(computeSubIndex("pm25", 500)).toBe(500);   // top of the standard scale
    // Above scale: last band is (250-500 → 401-500), slope 99/250 = 0.396.
    // value = 1500 → 401 + 0.396*(1500-250) = 401 + 495 = 896
    expect(computeSubIndex("pm25", 1500)).toBe(896);
    // Very extreme concentration would extrapolate above 1000; capped at 1000.
    expect(computeSubIndex("pm25", 3000)).toBe(1000);
  });

  it("throws for negative concentrations", () => {
    expect(() => computeSubIndex("pm25", -5)).toThrow(/negative/i);
  });

  it("returns exact boundary values for PM10", () => {
    expect(computeSubIndex("pm10", 50)).toBe(50);
    expect(computeSubIndex("pm10", 100)).toBe(100);
    expect(computeSubIndex("pm10", 250)).toBe(200);
    expect(computeSubIndex("pm10", 350)).toBe(300);
  });

  it("handles CO correctly (mg/m³, not µg/m³)", () => {
    expect(computeSubIndex("co", 1.0)).toBe(50);
    expect(computeSubIndex("co", 2.0)).toBe(100);
    expect(computeSubIndex("co", 10)).toBe(200);
  });
});

describe("computeSubIndex (EPA scale, sanity)", () => {
  it("matches EPA boundary values for PM2.5", () => {
    expect(computeSubIndex("pm25", 9.0, "epa")).toBe(50);
    expect(computeSubIndex("pm25", 35.4, "epa")).toBe(100);
    expect(computeSubIndex("pm25", 55.4, "epa")).toBe(150);
  });

  it("gives different sub-indices than NAQI for the same value", () => {
    // PM2.5 = 60 is the killer example from the design discussion:
    //   NAQI: 100 (Satisfactory)
    //   EPA:  ~156 (Unhealthy)
    expect(computeSubIndex("pm25", 60)).toBe(100);
    expect(computeSubIndex("pm25", 60, "epa")).toBeGreaterThan(150);
  });
});

describe("computeAqiFromMeasurements", () => {
  it("returns the sub-index for a single-pollutant measurement (NAQI)", () => {
    expect(computeAqiFromMeasurements([{ pollutant: "pm25", value: 60 }])).toBe(100);
  });

  it("returns the MAX of sub-indices across multiple pollutants", () => {
    // pm25=60 → 100, pm10=50 → 50, no2=40 → 50. Max = 100.
    const composite = computeAqiFromMeasurements([
      { pollutant: "pm25", value: 60 },
      { pollutant: "pm10", value: 50 },
      { pollutant: "no2",  value: 40 },
    ]);
    expect(composite).toBe(100);
  });

  it("picks the 'worst pollutant', not an average", () => {
    // pm25=90 → 200 dominates even if o3 is low.
    const composite = computeAqiFromMeasurements([
      { pollutant: "pm25", value: 90 },
      { pollutant: "o3",   value: 30 },
    ]);
    expect(composite).toBe(200);
  });

  it("throws for an empty measurements array", () => {
    expect(() => computeAqiFromMeasurements([])).toThrow(/empty/);
  });

  it("honours the scale argument", () => {
    // Under NAQI, pm25=60 → 100. Under EPA, > 150.
    const naqi = computeAqiFromMeasurements([{ pollutant: "pm25", value: 60 }]);
    const epa  = computeAqiFromMeasurements([{ pollutant: "pm25", value: 60 }], "epa");
    expect(naqi).toBe(100);
    expect(epa).toBeGreaterThan(150);
  });
});

describe("convertToCanonical", () => {
  it("returns value unchanged when unit already matches canonical", () => {
    expect(convertToCanonical("pm25", 45,  "µg/m³")).toBe(45);
    expect(convertToCanonical("pm10", 100, "µg/m³")).toBe(100);
    expect(convertToCanonical("o3",   80,  "µg/m³")).toBe(80);
    expect(convertToCanonical("co",   1.5, "mg/m³")).toBe(1.5);
  });

  it("converts between µg/m³ and mg/m³ (factor of 1000)", () => {
    expect(convertToCanonical("co",   1500, "µg/m³")).toBe(1.5);
    expect(convertToCanonical("pm25", 1.5,  "mg/m³")).toBe(1500);
  });

  it("converts ppb → µg/m³ for NO2, SO2, O3", () => {
    // 100 ppb × molar-mass factor at 25 °C, 1 atm
    expect(convertToCanonical("no2", 100, "ppb")).toBeCloseTo(188, 0); // 46.01 / 24.45
    expect(convertToCanonical("so2", 100, "ppb")).toBeCloseTo(262, 0); // 64.07 / 24.45
    expect(convertToCanonical("o3",  100, "ppb")).toBeCloseTo(196, 0); // 48.00 / 24.45
  });

  it("converts ppb → mg/m³ for CO (the OpenAQ bug case)", () => {
    // 500 ppb CO = 0.5725 mg/m³ → NAQI ~29 (Good).
    // Without this conversion, treating 500 ppb as 500 mg/m³ would give
    // NAQI 500 (Severe) — off by ~1000× and every CO reading would look extreme.
    const canonical = convertToCanonical("co", 500, "ppb");
    expect(canonical).toBeCloseTo(0.5725, 3);
    // Sanity: sub-index computed on the canonical value should be Good, not Severe.
    expect(computeSubIndex("co", canonical!)).toBeLessThan(50);
  });

  it("converts ppm → canonical for gases", () => {
    // 1 ppm NO2 = 1.88 mg/m³ = 1880 µg/m³
    expect(convertToCanonical("no2", 1, "ppm")).toBeCloseTo(1880, 0);
    // 1 ppm CO = 1.145 mg/m³
    expect(convertToCanonical("co", 1, "ppm")).toBeCloseTo(1.145, 3);
  });

  it("returns null for unrecognized units", () => {
    expect(convertToCanonical("pm25", 45, "grains/liter")).toBeNull();
    expect(convertToCanonical("no2",  100, "ppq")).toBeNull();
  });
});
