-- 17. Running bias correction for the daily forecast.
--
-- WHY. Measured 2026-10-08 over 2,490 station-days: the forecast under-predicts
-- systematically during the autumn ramp, because it is anchored to a seasonal
-- climatology and to a reading that is a median 3.0 days old. Both anchors look
-- backwards, so when levels climb 30-115% in ten days the forecast lags.
--
--   city        actual 22-28 Sep -> 29 Sep-8 Oct    bias before -> after
--   Kolkata     59 -> 126                           -9  -> -43
--   Pune        70 -> 111                           -17 -> -33
--   Chennai     82 ->  75                           -29 -> -14   (level FELL)
--
-- Chennai is the control: the only city whose level fell is the only one whose
-- bias improved. The lag is the cause, not a defect in any one serving mode --
-- forecast, outlook and seasonal_normal all show it about equally.
--
-- A backtest of a strictly causal 3-day correction cut MAE 23.2 -> 18.1 (-22%)
-- and bias -13.4 -> -2.4.

-- Keep the uncorrected number. Without it, tomorrow's bias would be learned
-- from today's already-corrected forecasts and the correction would chase its
-- own tail.
ALTER TABLE forecast_daily
  ADD COLUMN IF NOT EXISTS value_raw numeric;

COMMENT ON COLUMN forecast_daily.value_raw IS
  'The model output before bias correction. NULL means no correction was applied, in which case value is the raw number. Bias is always learned from this column.';

COMMENT ON COLUMN forecast_daily.value IS
  'What the app serves: bias-corrected when a correction was applied for this city and pollutant, otherwise identical to value_raw.';

-- One row per city and pollutant, rewritten every night.
CREATE TABLE IF NOT EXISTS forecast_bias (
  city         text        NOT NULL,
  pollutant    text        NOT NULL,
  offset_value numeric     NOT NULL,
  applied      boolean     NOT NULL,
  reason       text        NOT NULL,
  n_days       integer     NOT NULL,
  mae_raw      numeric,
  mae_corrected numeric,
  computed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (city, pollutant)
);

COMMENT ON TABLE forecast_bias IS
  'Running forecast bias per city and pollutant, refreshed nightly. `applied` is the self-policing decision: a correction is only used where it has been reducing error recently. Mumbai is the case that motivated this -- its true bias is small enough that correcting it added noise (MAE 17.0 -> 18.4 in backtest) while Pune, Kolkata and Bangalore improved 38-39%.';

COMMENT ON COLUMN forecast_bias.offset_value IS
  'Mean (forecast - actual) over the recent window, from value_raw. Positive means the model has been over-forecasting; it is SUBTRACTED from the forecast.';

COMMENT ON COLUMN forecast_bias.reason IS
  'Why applied is true or false, in words, so a surprising forecast can be explained without re-deriving the decision.';

-- Readable by anyone: it explains a number the app already shows.
ALTER TABLE forecast_bias ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "forecast_bias is public" ON forecast_bias;
CREATE POLICY "forecast_bias is public"
  ON forecast_bias FOR SELECT
  USING (true);
