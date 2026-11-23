-- 30. station_monthly_climate: each station's air, month by month, year by year.
--
-- WHY. The "Historical trends" chart (Map tab station card, Trends tab) shows
-- the yearly pattern of AQI or PM2.5: for each month, the average daily low,
-- mean and high across all years, plus one line per year. The history behind
-- it is 15+ years of daily rows, most of them in Storage files rather than the
-- database (they were moved out to stay under the 500 MB free limit), so the
-- app cannot compute this per tap. A monthly job boils it down into this table.
--
-- WHO WRITES IT. scripts/climate/build_station_climate.py, run monthly by
-- .github/workflows/forecast-refit.yml with the service key. It rebuilds every
-- row from scratch each time (upsert, then delete rows it no longer produces).
-- Nothing else writes here, and visitors can only read.
--
-- SIZE. About 21,500 rows (166 stations x 2 metrics x their years x 12
-- months), roughly 3-4 MB including the index. Measured with a dry run of the
-- builder on 23 Nov 2026.
--
-- WHAT COULD GO WRONG. Additive only: a new, empty table. No existing table,
-- row or policy is touched. If the builder has not run yet, the app's
-- Historical trends chart says there is no history for the station; nothing
-- else is affected.
--
-- ORDER. Any time. Run this, then run the builder once by hand (or wait for
-- the 1st of the month):
--   python -m scripts.climate.build_station_climate --apply
-- Afterwards:
--   SELECT metric, count(*), count(DISTINCT monitor_id) FROM station_monthly_climate GROUP BY metric;

BEGIN;

CREATE TABLE station_monthly_climate (
  monitor_id          UUID     NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  -- What the person chose to see (lib/prefs.ts): composite AQI or PM2.5.
  metric              TEXT     NOT NULL CHECK (metric IN ('pm25', 'aqi')),
  -- Calendar year and month of IST days, read straight off the stored date.
  year                SMALLINT NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  month               SMALLINT NOT NULL CHECK (month BETWEEN 1 AND 12),
  -- How many COMPLETE days (daily_quality rule) went into this row. The app
  -- ignores months with too few (lib/api/climate.ts) -- kept here, rather than
  -- filtered by the builder, so that threshold can change without a rebuild.
  n_days              SMALLINT NOT NULL CHECK (n_days BETWEEN 1 AND 31),
  -- Averages over the month's complete days of each day's mean, low and high.
  -- For metric 'aqi' the daily MEAN is the official AQI (CPCB's NAQI is on
  -- 24-hour averages); the daily low and high are sub-indices of the day's
  -- lowest and highest short readings, NOT official AQI values.
  mean_of_means       REAL     NOT NULL,
  mean_of_mins        REAL     NOT NULL,
  mean_of_maxes       REAL     NOT NULL,
  -- The spread of the daily means within the month.
  lowest_daily_mean   REAL     NOT NULL,
  highest_daily_mean  REAL     NOT NULL,
  p10_daily_mean      REAL     NOT NULL,
  p90_daily_mean      REAL     NOT NULL,
  -- Which inputs the month came from, comma-separated: 'xkdr' (CPCB via
  -- XKDR, hourly, to 1 Sep 2025), 'openaq_archive' (to 16 Aug 2026),
  -- 'openaq' (our own rollups after that).
  sources             TEXT     NOT NULL,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Leads with monitor_id: the app always asks for a few stations' rows.
  PRIMARY KEY (monitor_id, metric, year, month)
);

COMMENT ON TABLE station_monthly_climate IS
  'Monthly summaries of complete days per station, metric (pm25 | aqi) and year, for the Historical trends chart. Rebuilt monthly by scripts/climate/build_station_climate.py. Public read; service key writes.';

-- Public read, like readings_daily and the forecast tables. With RLS on, the
-- service key still writes (it bypasses RLS); nobody else can.
ALTER TABLE station_monthly_climate ENABLE ROW LEVEL SECURITY;

CREATE POLICY station_monthly_climate_public_read ON station_monthly_climate
  FOR SELECT USING (true);

-- Grants (Supabase no longer adds these automatically for new tables, from
-- 30 Oct 2026). Visitors: read only. The builder: read and write.
REVOKE ALL ON station_monthly_climate FROM PUBLIC, anon, authenticated;
GRANT SELECT ON station_monthly_climate TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON station_monthly_climate TO service_role;

COMMIT;
