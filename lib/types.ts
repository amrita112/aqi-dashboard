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
  aqi_value: number;           // The AQI number (0–500, EPA scale)
  latitude: number;            // GPS latitude (e.g., 28.6139 for Delhi)
  longitude: number;           // GPS longitude (e.g., 77.2090 for Delhi)
  image_url: string | null;    // Future: URL to a photo of the monitor
  device_type: string | null;  // Future: model/brand of the AQI monitor
  source: DataSource;          // Where this reading came from (user, openaq, government, simulated)
  recorded_at: string;         // When the reading was taken (ISO timestamp)
  created_at: string;          // When the row was saved to the database
}

/** The form data when a user submits a new reading (before it hits the database) */
export interface ReadingInsert {
  user_id: string;
  aqi_value: number;
  latitude: number;
  longitude: number;
  recorded_at: string;
  source?: DataSource;         // Optional — defaults to 'user' in the database
}

/** A user's profile information */
export interface Profile {
  id: string;
  display_name: string | null;
  created_at: string;
}

/**
 * EPA AQI categories.
 * Each range of AQI values maps to a category with a color and health message.
 * For example, 0–50 is "Good" (green), 301–500 is "Hazardous" (maroon).
 */
export interface AqiCategory {
  label: string;     // e.g., "Good", "Unhealthy", "Hazardous"
  color: string;     // CSS color for display
  min: number;       // Lower bound of AQI range
  max: number;       // Upper bound of AQI range
}
