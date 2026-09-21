-- =============================================================================
-- Migration: forecast tables
-- =============================================================================
-- Four tables plus a serving-mode lookup. The split follows one rule: precompute
-- everything that does not depend on the user's location, and leave only the
-- location-dependent arithmetic to request time.
--
-- The user's location is continuous, so we cannot enumerate a forecast for every
-- point someone might stand on. But we can precompute per STATION and average
-- the nearest few when a request arrives. That is only valid because the model
-- is linear in its inputs and alpha is shared per city -- measured, the two
-- routes differ by 0.5-1.3 ug/m3 against forecast errors of 7-35.
--
-- Everything here is derived and disposable. Losing it costs one refit, not
-- data. See docs/forecast-architecture.md.
-- =============================================================================

-- ─── 1. Fitted model parameters, per station and pollutant ──────────────────
-- Refit monthly. The climatology is a 366-element array rather than 366 rows:
-- one row per station-pollutant keeps this near 1 MB instead of ~15 MB, and it
-- is always read whole anyway.
CREATE TABLE IF NOT EXISTS forecast_params (
  monitor_id      UUID             NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  pollutant       TEXT             NOT NULL CHECK (pollutant IN ('pm25', 'pm10', 'no2', 'so2', 'aqi')),
  climatology     DOUBLE PRECISION[] NOT NULL,   -- 366 values, indexed by day-of-year
  alpha_h1        DOUBLE PRECISION NOT NULL,     -- anomaly-carry weight per horizon
  alpha_h2        DOUBLE PRECISION NOT NULL,
  alpha_h3        DOUBLE PRECISION NOT NULL,
  -- Which model won for this station's city in the backtest. Genuinely varies:
  -- persistence wins in Mumbai, Hyderabad and Pune, the blend elsewhere.
  model           TEXT             NOT NULL CHECK (model IN ('blend', 'persistence', 'climatology')),
  -- Days of history behind the fit. Thin stations get excluded at serve time
  -- rather than silently producing a confident number from three weeks of data.
  history_days    INTEGER          NOT NULL,
  fitted_at       TIMESTAMPTZ      NOT NULL DEFAULT now(),
  PRIMARY KEY (monitor_id, pollutant)
);

COMMENT ON COLUMN forecast_params.climatology IS
  'Smoothed day-of-year mean, 366 elements, index 1..366. Element 0 unused.';
COMMENT ON COLUMN forecast_params.history_days IS
  'Days of observations behind this fit; serving excludes stations under ~365.';

-- ─── 2. Diurnal shape, per city ─────────────────────────────────────────────
-- Ratio of each hour to that day's mean. A RATIO, so it scales with the level:
-- a shape learned in a clean month still applies in a dirty one.
--
-- Held per city rather than per station because the shape is a regional
-- pattern and per-station shapes would need far more history for a modest
-- gain. Untested whether traffic-adjacent stations need their own.
CREATE TABLE IF NOT EXISTS diurnal_shape (
  city        TEXT             NOT NULL,
  pollutant   TEXT             NOT NULL CHECK (pollutant IN ('pm25', 'pm10', 'no2', 'so2', 'aqi')),
  month       SMALLINT         NOT NULL CHECK (month BETWEEN 1 AND 12),
  hour        SMALLINT         NOT NULL CHECK (hour BETWEEN 0 AND 23),
  ratio       DOUBLE PRECISION NOT NULL,
  n_days      INTEGER          NOT NULL,   -- days behind this cell; thin cells are suspect
  PRIMARY KEY (city, pollutant, month, hour)
);

COMMENT ON TABLE diurnal_shape IS
  'Multiply a daily forecast by this to get an hourly one. Also powers "best time of day".';

-- ─── 3. Nightly forecast output, per station ────────────────────────────────
-- Seven days ahead per station-pollutant, rewritten each night. Days 1-3 are a
-- forecast; 4-7 are the seasonal normal and must be labelled as such.
CREATE TABLE IF NOT EXISTS forecast_daily (
  monitor_id       UUID             NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  pollutant        TEXT             NOT NULL CHECK (pollutant IN ('pm25', 'pm10', 'no2', 'so2', 'aqi')),
  target_date      DATE             NOT NULL,
  horizon_days     SMALLINT         NOT NULL CHECK (horizon_days BETWEEN 1 AND 7),
  value            DOUBLE PRECISION NOT NULL,
  -- Band half-widths as a FRACTION of value, so one number serves Delhi at 200
  -- and Bengaluru at 30. NULL beyond horizon 3: days 4-7 are an average, and a
  -- band around an average implies a prediction we are not making.
  band_p50         DOUBLE PRECISION,
  band_p80         DOUBLE PRECISION,
  -- How the app must describe this row. Chosen from forecast_modes using the
  -- age of the observation it was built from -- not fixed per horizon, because
  -- OpenAQ's publication lag swings between 17h and 80h+.
  mode             TEXT             NOT NULL CHECK (mode IN ('forecast', 'outlook', 'seasonal_normal')),
  model            TEXT             NOT NULL,
  -- Provenance, so the UI can say "based on a reading 19 hours old" instead of
  -- implying the number is live.
  based_on_date    DATE,
  data_age_days    SMALLINT,
  computed_at      TIMESTAMPTZ      NOT NULL DEFAULT now(),
  PRIMARY KEY (monitor_id, pollutant, target_date)
);

-- Serving path: given k nearby monitors, fetch their next 7 days at once.
CREATE INDEX IF NOT EXISTS forecast_daily_lookup_idx
  ON forecast_daily (monitor_id, pollutant, target_date);

-- "What does the whole city look like on Thursday" and staleness sweeps.
CREATE INDEX IF NOT EXISTS forecast_daily_date_idx
  ON forecast_daily (target_date);

-- ─── 4. Serving mode by data age ────────────────────────────────────────────
-- The rule for degrading honestly. For each (city, pollutant, data age,
-- horizon) it records measured skill against climatology and the mode that
-- follows. Thresholds are anchored, not chosen: 0% skill IS the seasonal
-- average computed the long way round, and 5% sits inside the backtest's noise.
CREATE TABLE IF NOT EXISTS forecast_modes (
  city             TEXT             NOT NULL,
  pollutant        TEXT             NOT NULL CHECK (pollutant IN ('pm25', 'pm10', 'no2', 'so2', 'aqi')),
  data_age_days    SMALLINT         NOT NULL CHECK (data_age_days BETWEEN 0 AND 14),
  horizon_days     SMALLINT         NOT NULL CHECK (horizon_days BETWEEN 1 AND 7),
  expected_mae     DOUBLE PRECISION NOT NULL,
  climatology_mae  DOUBLE PRECISION NOT NULL,
  skill_pct        DOUBLE PRECISION NOT NULL,
  band_p50         DOUBLE PRECISION,
  band_p80         DOUBLE PRECISION,
  mode             TEXT             NOT NULL CHECK (mode IN ('forecast', 'outlook', 'seasonal_normal')),
  fitted_at        TIMESTAMPTZ      NOT NULL DEFAULT now(),
  PRIMARY KEY (city, pollutant, data_age_days, horizon_days)
);

COMMENT ON TABLE forecast_modes IS
  'Serving-mode lookup. Read with the age of a station''s freshest reading to decide whether to call the number a forecast.';

-- ─── RLS: public read, service_role writes ──────────────────────────────────
ALTER TABLE forecast_params ENABLE ROW LEVEL SECURITY;
ALTER TABLE diurnal_shape   ENABLE ROW LEVEL SECURITY;
ALTER TABLE forecast_daily  ENABLE ROW LEVEL SECURITY;
ALTER TABLE forecast_modes  ENABLE ROW LEVEL SECURITY;

CREATE POLICY forecast_params_public_read ON forecast_params FOR SELECT USING (true);
CREATE POLICY diurnal_shape_public_read   ON diurnal_shape   FOR SELECT USING (true);
CREATE POLICY forecast_daily_public_read  ON forecast_daily  FOR SELECT USING (true);
CREATE POLICY forecast_modes_public_read  ON forecast_modes  FOR SELECT USING (true);
