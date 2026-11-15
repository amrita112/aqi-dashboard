-- 22. Serve the model each data age measured best with, and the alpha it was
--     measured with.
--
-- WHY. The Nov 2026 audit found two mismatches between what the refit measured
-- and what the nightly job served:
--
--   1. alpha. The mode table measured skill with alpha fitted for the
--      EFFECTIVE horizon (data age + days ahead), but forecast_params only
--      stored alpha for 1-3 days, so nightly served alpha_h3 for every
--      effective horizon above 3. At typical data ages that carried 1.3-4x
--      more of today's departure from normal than had been validated.
--
--   2. model. The refit picked persistence for Mumbai, Hyderabad and Pune,
--      but nightly always computed the blend and only copied the name.
--
-- WHAT CHANGES. Two new columns, both filled by the next refit:
--
--   forecast_params.alphas  alpha for effective horizons 1-10, indexed by
--                           effective horizon (element 0 unused, like
--                           climatology). alpha_h1..alpha_h3 stay filled.
--   forecast_modes.model    the model served at that (city, pollutant, data
--                           age, horizon): whichever of blend and persistence
--                           measured better on held-out data. Its skill, band
--                           and mode are that model's.
--
-- Additive only: no data is deleted or rewritten. Until the refit runs, rows
-- have NULL in both columns, which nightly reads as "blend, with alpha only
-- for effective horizons 1-3" -- exactly what those rows measured.
--
-- Existing tables, so no new GRANTs are needed (see the 30 Oct 2026 change).

ALTER TABLE forecast_params
  ADD COLUMN alphas DOUBLE PRECISION[];

COMMENT ON COLUMN forecast_params.alphas IS
  'Anomaly-carry weight per EFFECTIVE horizon (data age + days ahead), index 1..10, element 0 unused. Nightly serves alphas[age + h] -- the same alpha forecast_modes measured the skill with.';

ALTER TABLE forecast_modes
  ADD COLUMN model TEXT CHECK (model IN ('blend', 'persistence'));

COMMENT ON COLUMN forecast_modes.model IS
  'Model served at this data age and horizon: whichever of blend and persistence had the better median station skill on the held-out year. expected_mae, skill_pct, bands and mode all describe this model. NULL = fitted before Nov 2026, i.e. blend.';

COMMENT ON COLUMN forecast_params.model IS
  'Summary only: the model served most often for this city where there is a forecast. Nightly reads the model from forecast_modes, per data age.';
