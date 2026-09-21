-- 11. readings_daily: store EVERY timestamp at the daily min and max
--
-- Why
-- ---
-- min_ts / max_ts were single timestamps chosen by idxmin()/idxmax(), which
-- return whichever matching row came first. Row order from PostgREST is not
-- guaranteed, so re-rolling the same day could produce a different timestamp
-- for the same value -- observed on 2026-09-12: 11 of 518 rows changed between
-- two runs over identical data.
--
-- That is not merely untidy. These columns exist to answer "when is the air
-- cleanest here", and on 2026-09-12 42% of station-pollutant series had a TIED
-- minimum and 41% a tied maximum. Keeping one arbitrary member of the tie
-- throws away most of the answer.
--
-- Shape
-- -----
-- Arrays of every matching timestamp, plus the untruncated tie count so a
-- capped array is visibly capped rather than silently short. Distribution on
-- 2026-09-12: median 1 tie, p90 4, p99 32, worst 96 -- that worst case is a
-- sensor that reported one identical value for all 96 intervals, so the cap
-- keeps a stuck sensor from bloating the row.

ALTER TABLE readings_daily
  ADD COLUMN IF NOT EXISTS min_ts_all     TIMESTAMPTZ[],
  ADD COLUMN IF NOT EXISTS max_ts_all     TIMESTAMPTZ[],
  ADD COLUMN IF NOT EXISTS min_tie_count  INTEGER,
  ADD COLUMN IF NOT EXISTS max_tie_count  INTEGER,
  -- True when every reading that day was the same value: min == max, so the
  -- "cleanest time" is undefined and the sensor is probably stuck. Cheaper to
  -- flag here than to re-derive from the arrays at query time.
  ADD COLUMN IF NOT EXISTS is_flat        BOOLEAN DEFAULT FALSE;

COMMENT ON COLUMN readings_daily.min_ts_all IS
  'Every timestamp at the daily minimum, capped (see min_tie_count for the true total).';
COMMENT ON COLUMN readings_daily.max_ts_all IS
  'Every timestamp at the daily maximum, capped (see max_tie_count for the true total).';
COMMENT ON COLUMN readings_daily.min_tie_count IS
  'How many readings tied at the minimum, before any cap.';
COMMENT ON COLUMN readings_daily.is_flat IS
  'Every reading that day was identical — a stuck sensor; min/max timestamps are meaningless.';

-- min_ts / max_ts are kept as the first element of each array so existing
-- readers keep working. Drop them once nothing depends on them.
