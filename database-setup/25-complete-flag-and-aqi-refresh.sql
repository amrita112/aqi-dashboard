-- 25. readings_daily.is_complete, and readings.aqi_value that can be refreshed.
--
-- WHY.
--
--   is_complete  The completeness rule (>= 16 hours of readings, a plausible
--                mean; see lib/daily-quality-config.json) was applied by every
--                reader separately. Now the rollup decides it ONCE when it
--                writes the row, and every reader filters on this column.
--                Partial days are still STORED: the prune job checks that raw
--                readings are summarised before deleting them, and a day a
--                station never finishes should keep its count rather than
--                vanish.
--
--   aqi_value    Was written once, from whichever pollutants had arrived for
--                that timestamp, and never updated (audit §1.2, §4). OpenAQ
--                publishes pollutants in separate bursts, so the newest hours
--                were often an AQI from NO2 or SO2 alone. The ingests now
--                recompute it when new measurements arrive, and leave it EMPTY
--                (NULL) when PM2.5 and PM10 are not both present, rather than
--                store a number that understates the air. That needs NOT NULL
--                dropped; the 0-1000 CHECK stays.
--
-- WHAT CHANGES
--
--   1. readings_daily.is_complete, filled in here for every OpenAQ row from
--      the same rule. The XKDR rows are left NULL: they are about to be
--      deleted (cleanup step "delete the XKDR rows"), nothing reads them once
--      the new code is live, and updating ~1M rows now would grow a database
--      that is already over its size limit.
--   2. readings.aqi_value may be NULL.
--   3. set_reading_aqi(ids, values): rewrites aqi_value for many readings in
--      one call. Service key only -- the ingests and the repair script use it.
--
-- ORDER. Run BEFORE the merge. It only adds things, so the code currently live
-- keeps working, and the new rollup and ingests find the column and function
-- waiting. (The new ingests write NULL aqi_value; before step 2 that would be
-- refused.)

BEGIN;

-- ─── 1. is_complete ─────────────────────────────────────────────────────────

ALTER TABLE readings_daily ADD COLUMN is_complete BOOLEAN;

COMMENT ON COLUMN readings_daily.is_complete IS
  'This pollutant-day has >= 16 hours of readings and a mean within 0-2000 (lib/daily-quality-config.json). Set by the rollup via scripts/forecast/daily_quality.py. Readers show and forecast from complete days only. NULL = not yet assessed.';

-- The same rule as daily_quality.computed_complete_mask, written out once for
-- the rows that already exist: the station's cadence from the 90th percentile
-- of its daily counts (above 30 = every 15 minutes, full day 96; otherwise
-- hourly, full day 24), and 16 of 24 hours required. From here on the rollup
-- sets the flag itself, with the Python function.
UPDATE readings_daily d
SET is_complete = (
      d.count >= CASE WHEN c.typical > 30 THEN 96 * 16 / 24 ELSE 24 * 16 / 24 END
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
  AND d.pollutant = c.pollutant;

-- ─── 2. aqi_value may be empty ──────────────────────────────────────────────

ALTER TABLE readings ALTER COLUMN aqi_value DROP NOT NULL;

COMMENT ON COLUMN readings.aqi_value IS
  'Composite AQI of this ONE timestamp: max sub-index of its measurements. NULL when PM2.5 and PM10 are not both present (lib/daily-quality-config.json, aqi_rule). Recomputed by the ingests whenever new measurements arrive for the reading.';

-- ─── 3. Bulk rewrite of aqi_value ───────────────────────────────────────────

CREATE FUNCTION set_reading_aqi(p_ids UUID[], p_values INTEGER[])
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  changed INTEGER;
BEGIN
  UPDATE readings r
  SET aqi_value = v.aqi
  FROM unnest(p_ids, p_values) AS v(id, aqi)
  WHERE r.id = v.id
    AND r.aqi_value IS DISTINCT FROM v.aqi;   -- untouched rows are not rewritten
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed;
END;
$$;

COMMENT ON FUNCTION set_reading_aqi(UUID[], INTEGER[]) IS
  'Set readings.aqi_value for many readings at once (NULL allowed). Only rows whose value actually changes are written. Service key only.';

REVOKE ALL ON FUNCTION set_reading_aqi(UUID[], INTEGER[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION set_reading_aqi(UUID[], INTEGER[]) TO service_role;

COMMIT;
