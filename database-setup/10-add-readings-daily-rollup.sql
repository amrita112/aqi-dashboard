-- =============================================================================
-- Migration: Daily rollup table for compressed long-term storage
-- =============================================================================
-- Raw readings + measurements are retained for the last 90 days only. Older
-- data gets rolled up into this table: one row per (monitor, pollutant, day)
-- with distribution stats (min/mean/max/p10/p50/p90) + timestamps of the
-- daily extremes. ~40x compression vs raw at current ingest rates.
--
-- Populated nightly by a rollup job that also deletes the raw rows it
-- summarized. See docs/v1-plan.md Phase 2 Week 6.
-- =============================================================================

CREATE TABLE IF NOT EXISTS readings_daily (
  monitor_id   UUID             NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  pollutant    TEXT             NOT NULL CHECK (pollutant IN ('pm25', 'pm10', 'no2', 'so2')),
  date         DATE             NOT NULL,
  count        INTEGER          NOT NULL CHECK (count > 0),
  mean         DOUBLE PRECISION NOT NULL,
  min          DOUBLE PRECISION NOT NULL,
  min_ts       TIMESTAMPTZ      NOT NULL,
  max          DOUBLE PRECISION NOT NULL,
  max_ts       TIMESTAMPTZ      NOT NULL,
  p10          DOUBLE PRECISION NOT NULL,
  p50          DOUBLE PRECISION NOT NULL,
  p90          DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (monitor_id, pollutant, date)
);

-- Cross-station queries by day / date range (e.g. "all of Delhi on 2026-09-15").
CREATE INDEX IF NOT EXISTS readings_daily_date_idx
  ON readings_daily (date);

-- Cross-station queries by pollutant + time (e.g. "PM2.5 across all stations, last month").
CREATE INDEX IF NOT EXISTS readings_daily_pollutant_date_idx
  ON readings_daily (pollutant, date);

-- Public read; only service_role writes (which bypasses RLS anyway).
ALTER TABLE readings_daily ENABLE ROW LEVEL SECURITY;

CREATE POLICY readings_daily_public_read ON readings_daily
  FOR SELECT USING (true);
