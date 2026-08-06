/**
 * AQI utility functions.
 *
 * Supports two scales via an optional `scale` argument on every function,
 * defaulting to DEFAULT_SCALE ('naqi'):
 *   - NAQI (India CPCB): Good / Satisfactory / Moderate / Poor / Very Poor / Severe
 *   - EPA  (US):         Good / Moderate / USG / Unhealthy / Very Unhealthy / Hazardous
 *
 * Both scales share the same 0–500 numeric range but use different
 * per-pollutant breakpoints, so the same concentration can produce 
 * different labels under each. See docs/v1-plan.md for the rationale on
 * choosing NAQI as the default.
 *
 * All computations use the *instantaneous* reading — no rolling time
 * averaging. Consumer real-time apps universally use this simplification;
 * regulatory 24-hour averaging answers a different question (chronic
 * exposure) than our product does (immediate decision support).
 */

import {
  AqiCategory,
  Pollutant,
  Scale,
  DEFAULT_SCALE,
} from "./types";

// ─── Category tables ─────────────────────────────────────────────────────────
// Each table defines the 6 AQI bands for one scale: label, color, and the
// integer range on the 0–500 scale (with the last band extended to 1000 to
// match the DB CHECK constraint on readings.aqi_value).

/** India CPCB NAQI category bands */
const NAQI_CATEGORIES: AqiCategory[] = [
  { label: "Good",         color: "#00b050", min: 0,   max: 50   },
  { label: "Satisfactory", color: "#92d050", min: 51,  max: 100  },
  { label: "Moderate",     color: "#ffff00", min: 101, max: 200  },
  { label: "Poor",         color: "#ff7e00", min: 201, max: 300  },
  { label: "Very Poor",    color: "#ff0000", min: 301, max: 400  },
  { label: "Severe",       color: "#7e0023", min: 401, max: 1000 },
];

/** US EPA category bands */
const EPA_CATEGORIES: AqiCategory[] = [
  { label: "Good",                            color: "#00e400", min: 0,   max: 50   },
  { label: "Moderate",                        color: "#ffff00", min: 51,  max: 100  },
  { label: "Unhealthy for Sensitive Groups",  color: "#ff7e00", min: 101, max: 150  },
  { label: "Unhealthy",                       color: "#ff0000", min: 151, max: 200  },
  { label: "Very Unhealthy",                  color: "#8f3f97", min: 201, max: 300  },
  { label: "Hazardous",                       color: "#7e0023", min: 301, max: 1000 },
];

const CATEGORIES: Record<Scale, AqiCategory[]> = {
  naqi: NAQI_CATEGORIES,
  epa:  EPA_CATEGORIES,
};

/** Which labels get white text (dark background) on each scale */
const DARK_LABELS: Record<Scale, string[]> = {
  naqi: ["Poor", "Very Poor", "Severe"],
  epa:  ["Unhealthy", "Very Unhealthy", "Hazardous"],
};

// ─── Per-pollutant breakpoint tables ─────────────────────────────────────────
// Each entry: concentration [c_lo, c_hi] → AQI sub-index [i_lo, i_hi].
// Composite AQI = max of per-pollutant sub-indices.
//
// Adjacent bands overlap on the boundary value (e.g., PM2.5 = 60 sits in
// both the (30,60) and (60,90) NAQI rows). The lookup uses .find(), which
// returns the first match — so boundary values are assigned to the lower band.

type Breakpoint = { c_lo: number; c_hi: number; i_lo: number; i_hi: number };

/** India CPCB NAQI breakpoints (all values in POLLUTANT_UNITS canonical units) */
const NAQI_BREAKPOINTS: Record<Pollutant, Breakpoint[]> = {
  pm25: [
    { c_lo: 0,    c_hi: 30,   i_lo: 0,   i_hi: 50  },
    { c_lo: 30,   c_hi: 60,   i_lo: 51,  i_hi: 100 },
    { c_lo: 60,   c_hi: 90,   i_lo: 101, i_hi: 200 },
    { c_lo: 90,   c_hi: 120,  i_lo: 201, i_hi: 300 },
    { c_lo: 120,  c_hi: 250,  i_lo: 301, i_hi: 400 },
    { c_lo: 250,  c_hi: 500,  i_lo: 401, i_hi: 500 },
  ],
  pm10: [
    { c_lo: 0,    c_hi: 50,   i_lo: 0,   i_hi: 50  },
    { c_lo: 50,   c_hi: 100,  i_lo: 51,  i_hi: 100 },
    { c_lo: 100,  c_hi: 250,  i_lo: 101, i_hi: 200 },
    { c_lo: 250,  c_hi: 350,  i_lo: 201, i_hi: 300 },
    { c_lo: 350,  c_hi: 430,  i_lo: 301, i_hi: 400 },
    { c_lo: 430,  c_hi: 1000, i_lo: 401, i_hi: 500 },
  ],
  o3: [
    { c_lo: 0,    c_hi: 50,   i_lo: 0,   i_hi: 50  },
    { c_lo: 50,   c_hi: 100,  i_lo: 51,  i_hi: 100 },
    { c_lo: 100,  c_hi: 168,  i_lo: 101, i_hi: 200 },
    { c_lo: 168,  c_hi: 208,  i_lo: 201, i_hi: 300 },
    { c_lo: 208,  c_hi: 748,  i_lo: 301, i_hi: 400 },
    { c_lo: 748,  c_hi: 2000, i_lo: 401, i_hi: 500 },
  ],
  no2: [
    { c_lo: 0,    c_hi: 40,   i_lo: 0,   i_hi: 50  },
    { c_lo: 40,   c_hi: 80,   i_lo: 51,  i_hi: 100 },
    { c_lo: 80,   c_hi: 180,  i_lo: 101, i_hi: 200 },
    { c_lo: 180,  c_hi: 280,  i_lo: 201, i_hi: 300 },
    { c_lo: 280,  c_hi: 400,  i_lo: 301, i_hi: 400 },
    { c_lo: 400,  c_hi: 1000, i_lo: 401, i_hi: 500 },
  ],
  so2: [
    { c_lo: 0,    c_hi: 40,   i_lo: 0,   i_hi: 50  },
    { c_lo: 40,   c_hi: 80,   i_lo: 51,  i_hi: 100 },
    { c_lo: 80,   c_hi: 380,  i_lo: 101, i_hi: 200 },
    { c_lo: 380,  c_hi: 800,  i_lo: 201, i_hi: 300 },
    { c_lo: 800,  c_hi: 1600, i_lo: 301, i_hi: 400 },
    { c_lo: 1600, c_hi: 3000, i_lo: 401, i_hi: 500 },
  ],
  co: [
    // CO breakpoints are in mg/m³ (all other pollutants in µg/m³).
    { c_lo: 0,    c_hi: 1.0,  i_lo: 0,   i_hi: 50  },
    { c_lo: 1.0,  c_hi: 2.0,  i_lo: 51,  i_hi: 100 },
    { c_lo: 2.0,  c_hi: 10,   i_lo: 101, i_hi: 200 },
    { c_lo: 10,   c_hi: 17,   i_lo: 201, i_hi: 300 },
    { c_lo: 17,   c_hi: 34,   i_lo: 301, i_hi: 400 },
    { c_lo: 34,   c_hi: 100,  i_lo: 401, i_hi: 500 },
  ],
};

/**
 * US EPA breakpoints. PM2.5 and PM10 use EPA's published µg/m³ ranges directly.
 * Gaseous pollutants (O3, NO2, SO2, CO) are approximate µg/m³ conversions from
 * EPA's ppb/ppm ranges — good enough for the "sanity check" role EPA plays as
 * a non-default alternative, but a proper EPA implementation should be
 * revisited with explicit unit conversion if EPA is ever promoted to default.
 */
const EPA_BREAKPOINTS: Record<Pollutant, Breakpoint[]> = {
  pm25: [
    { c_lo: 0.0,   c_hi: 9.0,  i_lo: 0,   i_hi: 50  },
    { c_lo: 9.1,  c_hi: 35.4,  i_lo: 51,  i_hi: 100 },
    { c_lo: 35.5,  c_hi: 55.4,  i_lo: 101, i_hi: 150 },
    { c_lo: 55.5,  c_hi: 125.4, i_lo: 151, i_hi: 200 },
    { c_lo: 125.5, c_hi: 225.4, i_lo: 201, i_hi: 300 },
    { c_lo: 225.5, c_hi: 500.4, i_lo: 301, i_hi: 500 },
  ],
  pm10: [
    { c_lo: 0,    c_hi: 54,    i_lo: 0,   i_hi: 50  },
    { c_lo: 55,   c_hi: 154,   i_lo: 51,  i_hi: 100 },
    { c_lo: 155,  c_hi: 254,   i_lo: 101, i_hi: 150 },
    { c_lo: 255,  c_hi: 354,   i_lo: 151, i_hi: 200 },
    { c_lo: 355,  c_hi: 424,   i_lo: 201, i_hi: 300 },
    { c_lo: 425,  c_hi: 604,   i_lo: 301, i_hi: 500 },
  ],
  o3: [
    // Approximate µg/m³ from EPA 8-hour ppm; imprecise, see comment above.
    { c_lo: 0,    c_hi: 108,   i_lo: 0,   i_hi: 50  },
    { c_lo: 108,  c_hi: 140,   i_lo: 51,  i_hi: 100 },
    { c_lo: 140,  c_hi: 170,   i_lo: 101, i_hi: 150 },
    { c_lo: 170,  c_hi: 210,   i_lo: 151, i_hi: 200 },
    { c_lo: 210,  c_hi: 400,   i_lo: 201, i_hi: 300 },
    { c_lo: 400,  c_hi: 1200,  i_lo: 301, i_hi: 500 },
  ],
  no2: [
    // Approximate µg/m³ from EPA 1-hour ppb.
    { c_lo: 0,    c_hi: 100,   i_lo: 0,   i_hi: 50  },
    { c_lo: 100,  c_hi: 188,   i_lo: 51,  i_hi: 100 },
    { c_lo: 188,  c_hi: 677,   i_lo: 101, i_hi: 150 },
    { c_lo: 677,  c_hi: 1221,  i_lo: 151, i_hi: 200 },
    { c_lo: 1221, c_hi: 2349,  i_lo: 201, i_hi: 300 },
    { c_lo: 2349, c_hi: 3853,  i_lo: 301, i_hi: 500 },
  ],
  so2: [
    // Approximate µg/m³ from EPA 1-hour ppb.
    { c_lo: 0,    c_hi: 92,    i_lo: 0,   i_hi: 50  },
    { c_lo: 92,   c_hi: 196,   i_lo: 51,  i_hi: 100 },
    { c_lo: 196,  c_hi: 485,   i_lo: 101, i_hi: 150 },
    { c_lo: 485,  c_hi: 796,   i_lo: 151, i_hi: 200 },
    { c_lo: 796,  c_hi: 1583,  i_lo: 201, i_hi: 300 },
    { c_lo: 1583, c_hi: 2631,  i_lo: 301, i_hi: 500 },
  ],
  co: [
    // CO in mg/m³, EPA 8-hour ppm converted.
    { c_lo: 0,    c_hi: 5.1,   i_lo: 0,   i_hi: 50  },
    { c_lo: 5.1,  c_hi: 10.8,  i_lo: 51,  i_hi: 100 },
    { c_lo: 10.8, c_hi: 14.3,  i_lo: 101, i_hi: 150 },
    { c_lo: 14.3, c_hi: 17.7,  i_lo: 151, i_hi: 200 },
    { c_lo: 17.7, c_hi: 34.9,  i_lo: 201, i_hi: 300 },
    { c_lo: 34.9, c_hi: 57.9,  i_lo: 301, i_hi: 500 },
  ],
};

const BREAKPOINTS: Record<Scale, Record<Pollutant, Breakpoint[]>> = {
  naqi: NAQI_BREAKPOINTS,
  epa:  EPA_BREAKPOINTS,
};

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Given an AQI value on the 0–500 (or up to 1000) scale, returns the category
 * band under the chosen scale.
 */
export function getAqiCategory(
  value: number,
  scale: Scale = DEFAULT_SCALE
): AqiCategory {
  const table = CATEGORIES[scale];
  const category = table.find((cat) => value >= cat.min && value <= cat.max);
  // Defensive: out-of-range values fall back to the worst (last) category.
  return category ?? table[table.length - 1];
}

/** Category color for a given AQI value. */
export function getAqiColor(value: number, scale: Scale = DEFAULT_SCALE): string {
  return getAqiCategory(value, scale).color;
}

/** Category label for a given AQI value. */
export function getAqiLabel(value: number, scale: Scale = DEFAULT_SCALE): string {
  return getAqiCategory(value, scale).label;
}

/**
 * Contrasting text color (black or white) for a given AQI value's background.
 * Dark-background categories get white text; light-background categories get black.
 */
export function getAqiTextColor(value: number, scale: Scale = DEFAULT_SCALE): string {
  return DARK_LABELS[scale].includes(getAqiLabel(value, scale)) ? "#ffffff" : "#000000";
}

/**
 * Compute the per-pollutant AQI sub-index for one measurement.
 * The value must be in POLLUTANT_UNITS[pollutant] canonical units.
 *
 * Values above the standard scale (top of the highest breakpoint band) are
 * handled by extrapolating linearly using that band's slope, then capping at
 * 1000 to match the DB CHECK on readings.aqi_value. This preserves severity
 * information for extreme events (e.g., Delhi winter PM2.5 above 500 µg/m³)
 * rather than silently flattening every above-scale reading to the ceiling.
 *
 * UI code is expected to display above-500 values with a "500+" or similar
 * treatment; the raw number is what's stored.
 */
export function computeSubIndex(
  pollutant: Pollutant,
  value: number,
  scale: Scale = DEFAULT_SCALE
): number {
  if (value < 0) {
    throw new Error(
      `Cannot compute sub-index for negative concentration: ${pollutant} = ${value}`
    );
  }
  const table = BREAKPOINTS[scale][pollutant];
  // Find the matching band, or fall back to the top band for above-scale values.
  const bp = table.find((b) => value >= b.c_lo && value <= b.c_hi)
    ?? table[table.length - 1];
  const subIndex =
    ((bp.i_hi - bp.i_lo) / (bp.c_hi - bp.c_lo)) * (value - bp.c_lo) + bp.i_lo;
  return Math.min(1000, Math.round(subIndex));
}

/**
 * Compute the composite AQI from a set of per-pollutant measurements.
 * Applies computeSubIndex() to each and returns the maximum.
 * Throws if given an empty array — a reading with no data can't yield an AQI.
 */
export function computeAqiFromMeasurements(
  measurements: Array<{ pollutant: Pollutant; value: number }>,
  scale: Scale = DEFAULT_SCALE
): number {
  if (measurements.length === 0) {
    throw new Error("Cannot compute AQI from an empty measurements array");
  }
  const subIndices = measurements.map((m) => computeSubIndex(m.pollutant, m.value, scale));
  return Math.max(...subIndices);
}
