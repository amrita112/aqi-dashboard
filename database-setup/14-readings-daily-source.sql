-- =============================================================================
-- Migration: mark where each readings_daily row came from
-- =============================================================================
-- readings_daily is about to hold two populations that look identical but are
-- not:
--
--   'openaq'  rolled up from our own raw readings. OpenAQ carries CPCB at
--             15-minute resolution, so a complete day has count ≈ 96.
--   'xkdr'    loaded from the XKDR historical export, which is HOURLY, so a
--             complete day has count ≈ 24.
--
-- Without this column the `count` on a row means different things depending on
-- an invisible property of its origin, and any completeness check -- including
-- the one in notebooks/rollup_verification.ipynb -- would read every historical
-- row as three-quarters missing.
--
-- The values themselves are comparable: both are daily means over whatever the
-- station reported. It is only the DENOMINATOR that differs.
-- =============================================================================

ALTER TABLE readings_daily
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'openaq';

COMMENT ON COLUMN readings_daily.source IS
  'openaq = rolled up from raw 15-minute readings (count ~96/day); xkdr = historical hourly export (count ~24/day).';

-- History is queried by date range far more than by station, and almost always
-- filtered to one source.
CREATE INDEX IF NOT EXISTS readings_daily_source_date_idx
  ON readings_daily (source, date);
