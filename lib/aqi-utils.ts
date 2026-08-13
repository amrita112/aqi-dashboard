/**
 * AQI utility functions.
 *
 * All numeric constants (category bands, per-pollutant breakpoints, unit
 * conversion factors) live in lib/aqi-config.json — the single source of
 * truth also read by the Python ingest scripts
 * (scripts/ingest/lib/aqi_utils.py). Edit the JSON to add a pollutant or
 * adjust a breakpoint; both languages pick up the change together.
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
  POLLUTANT_UNITS,
  Scale,
  DEFAULT_SCALE,
} from "./types";
import aqiConfig from "./aqi-config.json";

// ─── Scale data loaded from shared JSON ──────────────────────────────────────
// All breakpoints, category tables, dark-label lists, and unit-conversion
// factors live in lib/aqi-config.json — the single source of truth also read
// by the Python ingest scripts (scripts/ingest/lib/aqi_utils.py). Edit the
// JSON to change any of these; TypeScript and Python pick up changes together.

type Breakpoint = { c_lo: number; c_hi: number; i_lo: number; i_hi: number };

const CATEGORIES: Record<Scale, AqiCategory[]> = {
  naqi: aqiConfig.scales.naqi.categories as AqiCategory[],
  epa:  aqiConfig.scales.epa.categories  as AqiCategory[],
};

/** Which labels get white text (dark background) on each scale */
const DARK_LABELS: Record<Scale, string[]> = {
  naqi: aqiConfig.scales.naqi.dark_labels,
  epa:  aqiConfig.scales.epa.dark_labels,
};

const BREAKPOINTS: Record<Scale, Record<Pollutant, Breakpoint[]>> = {
  naqi: aqiConfig.scales.naqi.breakpoints as unknown as Record<Pollutant, Breakpoint[]>,
  epa:  aqiConfig.scales.epa.breakpoints  as unknown as Record<Pollutant, Breakpoint[]>,
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

// ─── Unit conversion ────────────────────────────────────────────────────────
// Ingest sources publish measurements in various units. OpenAQ, for example,
// publishes CO, NO2, and SO2 in ppb — but the NAQI/EPA breakpoint tables
// above expect canonical units per POLLUTANT_UNITS (µg/m³ for particulates
// and gaseous pollutants, mg/m³ for CO). Feeding raw ppb values into
// computeSubIndex() produces sub-indices off by ~1000× (e.g., a moderate CO
// reading of 500 ppb ≈ 0.57 mg/m³ = Good, but if we treat 500 ppb as
// 500 mg/m³ we get Severe). Always run raw data through convertToCanonical
// before computing sub-indices.
//
// Conversion factors are at 25 °C, 1 atm — the standard NAQI/CPCB assumption.
// The formula for gases is: (mg/m³) = ppm × (molar_mass_g_per_mol / 24.45).

/** ppb → µg/m³ multiplier for gases whose canonical unit is µg/m³ (from JSON). */
const PPB_TO_UGM3 = aqiConfig.unit_conversions.ppb_to_ugm3 as Partial<Record<Pollutant, number>>;

/** ppm → mg/m³ multiplier for gases whose canonical unit is mg/m³ (from JSON). */
const PPM_TO_MGM3 = aqiConfig.unit_conversions.ppm_to_mgm3 as Partial<Record<Pollutant, number>>;

/**
 * Convert a raw measurement to the canonical unit expected by computeSubIndex().
 *
 * Canonical units (see POLLUTANT_UNITS in lib/types.ts):
 *   pm25, pm10, o3, no2, so2 → µg/m³
 *   co                       → mg/m³
 *
 * Returns null when the unit is unrecognized for the given pollutant — caller
 * should drop the measurement and log the mismatch rather than silently
 * feeding a wrong-unit value into the sub-index formula.
 */
export function convertToCanonical(
  pollutant: Pollutant,
  value: number,
  unit: string,
): number | null {
  const canonical = POLLUTANT_UNITS[pollutant];
  if (unit === canonical) return value;

  // Particulate / CO mass unit shortcuts
  if (canonical === "µg/m³" && unit === "mg/m³") return value * 1000;
  if (canonical === "mg/m³" && unit === "µg/m³") return value / 1000;

  // Gas → µg/m³ (NO2, SO2, O3)
  const ppbFactor = PPB_TO_UGM3[pollutant];
  if (canonical === "µg/m³" && ppbFactor !== undefined) {
    if (unit === "ppb") return value * ppbFactor;
    if (unit === "ppm") return value * ppbFactor * 1000;
  }

  // Gas → mg/m³ (CO)
  const ppmFactor = PPM_TO_MGM3[pollutant];
  if (canonical === "mg/m³" && ppmFactor !== undefined) {
    if (unit === "ppm") return value * ppmFactor;
    if (unit === "ppb") return value * ppmFactor / 1000;
  }

  return null;
}

/**
 * Compute the per-pollutant AQI sub-index for one measurement.
 *
 * IMPORTANT: `value` MUST be in POLLUTANT_UNITS[pollutant] canonical units
 * (µg/m³ for most, mg/m³ for CO). If your source publishes different units
 * (e.g., OpenAQ publishes CO/NO2/SO2 in ppb), run through convertToCanonical()
 * first — otherwise sub-indices are wildly wrong (typically off by ~1000× for
 * gas ppb data).
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
