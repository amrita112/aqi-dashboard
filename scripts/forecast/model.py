"""
The forecast formula, and the constants that define what gets served.

Kept in this small module, with no database or file access, so that every
place that makes or checks a forecast imports the SAME arithmetic:

  * refit_params.py / baselines.py  -- measuring skill while fitting
  * nightly_forecast.py             -- serving
  * simulate.py                     -- replaying past nights
  * notebooks/forecast_verification.ipynb

THE TWO MODELS

  blend        climatology(target day) + alpha x (last reading - its climatology)
               Starts from the seasonal normal and carries a share (alpha) of
               today's departure from normal forward. alpha is fitted for the
               EFFECTIVE horizon: a reading `age` days old, forecasting `h` days
               ahead, is an (age + h)-day-ahead problem.

  persistence  the last reading, unchanged. Wins in cities with a shallow
               seasonal swing (Mumbai, Hyderabad, Pune in the 2024 backtest),
               where pulling towards the seasonal normal drags the forecast
               away from the truth.

Which one is served is decided per (city, pollutant, data age, horizon) by the
refit's mode table: whichever measured better on held-out data at that data
age. That choice, its measured skill and its error band are stored together in
forecast_modes, so the label on a row always describes the number it carries.
"""

from __future__ import annotations

from typing import Optional

SERVED_MODELS = ("blend", "persistence")

# Days ahead that get a real forecast. Beyond this the app serves the seasonal
# normal and labels it so.
FORECAST_HORIZONS = (1, 2, 3)

# Data ages (days since the newest complete reading) the mode table is measured
# at. Every integer, so serving never has to borrow a neighbouring age's skill.
# Older than the last one, there is no measured skill to claim, and the app
# serves the seasonal normal.
MODE_DATA_AGES = tuple(range(0, 8))
MAX_SERVED_DATA_AGE = MODE_DATA_AGES[-1]

# alpha is fitted for every effective horizon that can be served.
MAX_EFFECTIVE_HORIZON = MAX_SERVED_DATA_AGE + FORECAST_HORIZONS[-1]
EFFECTIVE_HORIZONS = tuple(range(1, MAX_EFFECTIVE_HORIZON + 1))


def predict(model: str, clim_target, last_value, clim_last, alpha):
    """One forecast, for scalars or aligned pandas Series alike.

    clim_target  climatology for the day being forecast
    last_value   the newest complete reading
    clim_last    climatology for the day of that reading
    alpha        anomaly-carry weight for this effective horizon (blend only)
    """
    if model == "persistence":
        return last_value
    if model == "blend":
        return clim_target + alpha * (last_value - clim_last)
    raise ValueError(f"unknown model {model!r}")


def alpha_for(params: dict, effective_horizon: int) -> Optional[float]:
    """The fitted alpha for this effective horizon, from a forecast_params row.

    Rows fitted before Nov 2026 only have alpha_h1..alpha_h3. Those are still
    exactly right for effective horizons 1-3, so they are used there. Beyond
    that this returns None, and the caller must not guess: the old code served
    alpha_h3 for every effective horizon above 3, which carried 1.3-4x more of
    the anomaly than the skill had been measured with (audit §7.2).
    """
    alphas = params.get("alphas")
    if alphas is not None:
        alphas = list(alphas)
        if effective_horizon < len(alphas) and alphas[effective_horizon] is not None:
            return float(alphas[effective_horizon])
        return None
    legacy = params.get(f"alpha_h{effective_horizon}")
    return float(legacy) if legacy is not None else None
