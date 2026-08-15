-- =============================================================================
-- Migration: Uniqueness constraints for ingest deduplication
-- =============================================================================
-- Adds the natural-key uniqueness the ingest scripts rely on for idempotent
-- writes. Without these constraints, a re-run of the hourly cron (or a daily
-- backfill that overlaps with the hourly window) would insert duplicate
-- rows. With them, the ingest can use INSERT ... ON CONFLICT DO NOTHING.
--
-- A "reading" is a station's measurement event at one timestamp from one
-- source. The natural key is (monitor_id, source, recorded_at).
--
-- A "measurement" is a per-pollutant number attached to a reading. The
-- natural key is (reading_id, pollutant).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Fix 1: Unique per-source station reading at a given timestamp.
-- -----------------------------------------------------------------------------
-- Partial index: only enforce for rows that actually have a monitor_id
-- (user-typed submissions have monitor_id = NULL and don't dedup this way).

CREATE UNIQUE INDEX IF NOT EXISTS readings_monitor_source_time_uniq
  ON readings (monitor_id, source, recorded_at)
  WHERE monitor_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- Fix 2: One measurement per pollutant per reading.
-- -----------------------------------------------------------------------------
-- If a station has two PM2.5 sensors, they'll produce two measurement rows
-- with different sensor IDs but the same (reading_id, pollutant). The ingest
-- upserts one canonical value per pollutant per reading (chosen by the
-- ingest logic — typically the highest sub-index or an averaged value).

CREATE UNIQUE INDEX IF NOT EXISTS measurements_reading_pollutant_uniq
  ON measurements (reading_id, pollutant);
