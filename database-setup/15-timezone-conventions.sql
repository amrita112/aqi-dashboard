-- =============================================================================
-- Migration: write the time base down
-- =============================================================================
-- Nothing here changes a value. It records, in the database itself, which
-- columns are INSTANTS and which are CALENDAR LABELS -- a distinction that was
-- never documented and cost two bugs.
--
-- The first: readings_daily.date meant an IST calendar day for rows loaded from
-- the XKDR history (load_history.py casts XKDR's naive local timestamps) and a
-- UTC calendar day for rows written by our own rollup. One column, two
-- meanings, selected by `source`. The climatology is fitted on the first and
-- the anomaly measured against the second, so every forecast subtracted an
-- IST-day average from a UTC-day observation. Measured 2026-09-22: a 2.26 ug/m3
-- PM2.5 gap, 7.6% of level, against a 5.4 ug/m3 median day-to-day change --
-- roughly 42% of the signal the anomaly exists to detect.
--
-- The second: diurnal_shape.hour is an IST hour, because it too is fitted from
-- XKDR. The forecast code looked it up by UTC hour, rotating every hourly
-- profile by 5h30m. The XKDR shape peaks at hour 21; our own readings peak at
-- UTC hour 16 -- the same moment, 21:30 IST.
--
-- The rule, in one line: STORE instants in UTC, GROUP calendar labels by IST.
--
-- An instant survives any timezone: it converts losslessly whenever it is read.
-- A calendar label does not. Once a daily mean has been averaged over the wrong
-- 24 hours the original is unrecoverable, and raw readings are pruned at 30
-- days. So the grouping has to be right when it is written, not when it is
-- displayed.
--
-- India-only product, so the calendar is India's.
-- =============================================================================

COMMENT ON COLUMN readings.recorded_at IS
  'INSTANT, UTC. When the air was measured, exactly as OpenAQ reported it.';

COMMENT ON COLUMN readings.created_at IS
  'INSTANT, UTC. When the row landed in our database. Never rewritten: the '
  'ingest upserts with ignore_duplicates, so this is the FIRST time we saw the '
  'reading. created_at - recorded_at is the publication lag.';

COMMENT ON COLUMN readings_daily.date IS
  'CALENDAR LABEL, IST. The Indian calendar day these statistics cover, i.e. '
  '18:30 UTC the previous day to 18:30 UTC on it. Both sources agree on this: '
  'XKDR history always did, and the rollup was corrected on 2026-09-22.';

COMMENT ON COLUMN readings_daily.min_ts IS
  'INSTANT, UTC. Convert to IST before showing a time of day to anyone.';

COMMENT ON COLUMN readings_daily.max_ts IS
  'INSTANT, UTC. Convert to IST before showing a time of day to anyone.';

COMMENT ON COLUMN diurnal_shape.hour IS
  'CALENDAR LABEL, IST (0-23). Fitted from XKDR, whose collected_at is naive '
  'Indian local time. Looking this up by a UTC hour rotates the profile 5h30m.';

COMMENT ON COLUMN forecast_daily.target_date IS
  'CALENDAR LABEL, IST. The Indian calendar day being forecast.';

COMMENT ON COLUMN forecast_params.climatology IS
  'Smoothed day-of-year mean, 366 elements, index 1..366. Element 0 unused. '
  'Day-of-year is an IST day-of-year, matching readings_daily.date.';
