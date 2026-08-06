-- =============================================================================
-- Migration: Add `measurements` table for per-pollutant data
-- =============================================================================
-- A `measurement` is one pollutant reading (PM2.5, PM10, O3, NO2, SO2, or CO)
-- attached to a parent `reading`. A reading can have:
--   - Zero measurements: user submitted a composite AQI value directly
--     (typed the number, or uploaded a photo we OCR'd to a single AQI).
--   - Many measurements: reading came from a station, connected monitor,
--     or richer picture that produced per-pollutant values.
--
-- The composite `readings.aqi_value` remains NOT NULL. When measurements
-- exist, aqi_value is expected to be computed from them at insert time
-- (via lib/aqi-utils.ts :: computeAqiFromMeasurements) and stored on the
-- parent row. This keeps reads fast and avoids joining every AQI display.
--
-- Units for each pollutant are fixed by convention (see POLLUTANT_UNITS in
-- lib/types.ts); the `unit` column documents what was stored but is not
-- used by the AQI computation itself.
-- =============================================================================

CREATE TABLE measurements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reading_id UUID NOT NULL REFERENCES readings(id) ON DELETE CASCADE,
  pollutant TEXT NOT NULL,
  value DOUBLE PRECISION NOT NULL,
  unit TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),

  -- Restrict pollutant to the six codes the AQI computation understands.
  -- If a new pollutant is added, expand this list AND add breakpoints in
  -- lib/aqi-utils.ts.
  CONSTRAINT measurements_pollutant_valid
    CHECK (pollutant IN ('pm25', 'pm10', 'o3', 'no2', 'so2', 'co')),

  -- Concentrations are non-negative.
  CONSTRAINT measurements_value_non_negative
    CHECK (value >= 0)
);

-- Index for the common query "all measurements for this reading".
CREATE INDEX measurements_reading_id_idx ON measurements (reading_id);

-- Index for "all measurements of this pollutant" (e.g., PM2.5 time series
-- across the whole database).
CREATE INDEX measurements_pollutant_idx ON measurements (pollutant);

-- =============================================================================
-- Row Level Security on measurements
-- =============================================================================
-- Same shape as `monitors`: public SELECT, no INSERT/UPDATE/DELETE policies
-- for regular users. Only the service_role key (admin ingest scripts, SQL
-- editor) can write. This matches the design that measurements are populated
-- by ingest pipelines (OpenAQ, government feeds, future connected monitors),
-- not by end-user form submissions.

ALTER TABLE measurements ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Measurements are viewable by everyone"
  ON measurements FOR SELECT
  USING (true);
