-- 26. A complete day needs 12 hours of readings, not 16.
--
-- WHY. Migration 25 marked readings_daily rows complete at >= 16 hours, CPCB's
-- rule for an official 24-hour average. On our data that was too strict:
-- OpenAQ often loses a few hours for EVERY station on the same day (a dropped
-- publication batch). Measured over 12 Oct - 14 Nov 2026, 16 hours kept only 9
-- of ~155 PM2.5 stations on 18 Oct, 27 Oct and 4 Nov; 12 hours keeps 135-148.
-- With 16, a "city average" on those days rested on a handful of stations --
-- in Mumbai on 18 Oct, one station reading 297 against ~60 elsewhere. 12 hours
-- is also what the original feasibility analysis was validated with.
--
-- The rule lives in lib/daily-quality-config.json (min_hours_for_complete_day
-- = 12), which the rollup reads from the next run on. This re-marks the rows
-- already stored, with the same formula as migration 25: the station's cadence
-- from the 90th percentile of its daily counts (above 30 = every 15 minutes,
-- full day 96; otherwise hourly, full day 24), now 12 of 24 hours required --
-- 48 readings for a 15-minute station, 12 for an hourly one.
--
-- Changes only the is_complete flag on OpenAQ rows; no data is added or
-- deleted. Safe to run before or after the merge. Re-running it is harmless.

BEGIN;

UPDATE readings_daily d
SET is_complete = (
      d.count >= CASE WHEN c.typical > 30 THEN 96 * 12 / 24 ELSE 24 * 12 / 24 END
      AND d.mean BETWEEN 0 AND 2000
    )
FROM (
  SELECT monitor_id, pollutant,
         percentile_cont(0.9) WITHIN GROUP (ORDER BY count) AS typical
  FROM readings_daily
  WHERE source = 'openaq'
  GROUP BY monitor_id, pollutant
) c
WHERE d.source = 'openaq'
  AND d.monitor_id = c.monitor_id
  AND d.pollutant = c.pollutant
  AND d.is_complete IS DISTINCT FROM (
      d.count >= CASE WHEN c.typical > 30 THEN 96 * 12 / 24 ELSE 24 * 12 / 24 END
      AND d.mean BETWEEN 0 AND 2000
  );

COMMENT ON COLUMN readings_daily.is_complete IS
  'This pollutant-day has >= 12 hours of readings and a mean within 0-2000 (lib/daily-quality-config.json). Set by the rollup via scripts/forecast/daily_quality.py. Readers show and forecast from complete days only. NULL = not yet assessed.';

COMMIT;
