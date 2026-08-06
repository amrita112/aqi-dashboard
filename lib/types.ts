/**
 * TypeScript types for the AQI Dashboard.
 * These define the shape of data throughout the app — like column headers in a spreadsheet.
 */

/**
 * The four data sources that readings can come from.
 * Used for filtering on the dashboard.
 */
export type DataSource = 'user' | 'openaq' | 'simulated' | 'government';

/** All possible data sources, in display order */
export const ALL_SOURCES: DataSource[] = ['user', 'openaq', 'government', 'simulated'];

/** Human-readable labels for each data source */
export const SOURCE_LABELS: Record<DataSource, string> = {
  user: 'User Entries',
  openaq: 'OpenAQ',
  government: 'Government',
  simulated: 'Simulated',
};

/** A single AQI reading submitted by a user */
export interface Reading {
  id: string;                  // Unique identifier for this reading (auto-generated)
  user_id: string;             // The user who submitted this reading
  monitor_id: string | null;   // The physical monitor this reading came from (nullable)
  aqi_value: number;           // Composite AQI (see lib/aqi-utils.ts for scale details)
  latitude: number;            // GPS latitude (e.g., 28.6139 for Delhi)
  longitude: number;           // GPS longitude (e.g., 77.2090 for Delhi)
  image_url: string | null;    // Future: URL to a photo of the monitor
  device_type: string | null;  // Future: model/brand of the AQI monitor
  source: DataSource;          // Where this reading came from (user, openaq, government, simulated)
  recorded_at: string;         // When the reading was taken (ISO timestamp)
  created_at: string;          // When the row was saved to the database
  measurements?: Measurement[]; // Per-pollutant child rows, populated only when
                               // the query explicitly fetches them (includeMeasurements: true)
}

/** The form data when a user submits a new reading (before it hits the database) */
export interface ReadingInsert {
  user_id: string;
  monitor_id?: string | null;  // Optional — if the reading came from a registered monitor
  aqi_value: number;
  latitude: number;
  longitude: number;
  recorded_at: string;
  source?: DataSource;         // Optional — defaults to 'user' in the database
}

/**
 * A physical air quality monitor (government station, handheld unit, etc.).
 * One row per device. Multiple users can upload readings from the same monitor
 * (e.g., after a private sale), and one user can use multiple monitors.
 */
export interface Monitor {
  id: string;                     // Internal UUID
  serial_number: string | null;   // Manufacturer's hardware serial; may be unknown
  manufacturer: string | null;    // E.g., "Plume Labs"; empty for now
  model: string | null;           // E.g., "Flow 2"; empty for now
  notes: string | null;           // Free-form description / commissioning info
  created_at: string;             // When the monitor was registered
  disabled_at: string | null;     // Soft-delete marker; non-null = retired
}

/** A user's profile information */
export interface Profile {
  id: string;
  display_name: string | null;
  created_at: string;
}

/**
 * An AQI category (one band on the 0–500 scale).
 * Definitions vary by scale — see NAQI_CATEGORIES vs EPA_CATEGORIES in aqi-utils.ts.
 */
export interface AqiCategory {
  label: string;     // e.g., "Good", "Poor", "Severe" (NAQI) or "Good", "Unhealthy" (EPA)
  color: string;     // CSS color for display
  min: number;       // Lower bound of AQI range
  max: number;       // Upper bound of AQI range
}

/**
 * The AQI scale to use for category labels, colors, and per-pollutant
 * sub-index computation.
 *   - 'naqi': India CPCB National Air Quality Index (default)
 *   - 'epa':  US EPA scale
 *
 * All AQI-related utility functions in lib/aqi-utils.ts accept an optional
 * scale argument; changing DEFAULT_SCALE below flips the app-wide default.
 */
export type Scale = 'naqi' | 'epa';

/** The scale used when none is explicitly passed */
export const DEFAULT_SCALE: Scale = 'naqi';

/** All supported scales */
export const ALL_SCALES: Scale[] = ['naqi', 'epa'];

/** Human-readable labels for each scale */
export const SCALE_LABELS: Record<Scale, string> = {
  naqi: 'India NAQI',
  epa:  'US EPA',
};

/**
 * The six pollutants that feed the composite AQI on both scales.
 * String codes match what OpenAQ and CPCB publish (lowercase, no punctuation).
 */
export type Pollutant = 'pm25' | 'pm10' | 'o3' | 'no2' | 'so2' | 'co';

/** All pollutants, in display order (particulates first, then gases) */
export const ALL_POLLUTANTS: Pollutant[] = ['pm25', 'pm10', 'o3', 'no2', 'so2', 'co'];

/** Human-readable labels for each pollutant */
export const POLLUTANT_LABELS: Record<Pollutant, string> = {
  pm25: 'PM2.5',
  pm10: 'PM10',
  o3:   'Ozone (O₃)',
  no2:  'Nitrogen Dioxide (NO₂)',
  so2:  'Sulphur Dioxide (SO₂)',
  co:   'Carbon Monoxide (CO)',
};

/**
 * The canonical unit each pollutant is expected to be stored in.
 * Values passed to computeAqiFromMeasurements() must be in these units,
 * otherwise the breakpoint interpolation produces wrong results.
 * Note: CO is mg/m³, not µg/m³.
 */
export const POLLUTANT_UNITS: Record<Pollutant, string> = {
  pm25: 'µg/m³',
  pm10: 'µg/m³',
  o3:   'µg/m³',
  no2:  'µg/m³',
  so2:  'µg/m³',
  co:   'mg/m³',
};

/**
 * A per-pollutant measurement, attached to a parent reading.
 * A reading may have zero measurements (composite AQI submitted directly by
 * a user) or many (station data, connected monitor, richer picture uploads).
 */
export interface Measurement {
  id: string;              // Auto-generated UUID
  reading_id: string;      // Parent reading (FK to readings.id)
  pollutant: Pollutant;    // Which pollutant this measurement is for
  value: number;           // Numeric concentration in POLLUTANT_UNITS[pollutant]
  unit: string;            // Should match POLLUTANT_UNITS[pollutant]
  created_at: string;
}

/** Form data for inserting a measurement (before it hits the database) */
export interface MeasurementInsert {
  reading_id: string;
  pollutant: Pollutant;
  value: number;
  unit: string;
}
