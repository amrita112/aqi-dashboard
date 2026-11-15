"""The refit's mode table picks the model that measured better, per data age."""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.forecast.baselines import forecast_mode_table, model_skill_table  # noqa: E402
from scripts.forecast.model import MODE_DATA_AGES  # noqa: E402

IDX = pd.date_range("2016-01-01", "2024-12-31", freq="D")
RNG = np.random.default_rng(0)


def seasonal_ar(phi=0.6, swing=80.0, noise=15.0):
    """Strong seasonal cycle plus short-memory noise: the blend's home ground."""
    seasonal = 120 + swing * np.cos(2 * np.pi * (IDX.dayofyear - 330) / 365.25)
    anom = np.zeros(len(IDX))
    for i in range(1, len(IDX)):
        anom[i] = phi * anom[i - 1] + RNG.normal(0, noise)
    return pd.Series(seasonal + anom, index=IDX, name="X")


def random_walk():
    """No seasonal cycle and long memory: persistence's home ground."""
    steps = RNG.normal(0, 4, len(IDX))
    return pd.Series(200 + np.cumsum(steps), index=IDX, name="X").clip(lower=5)


def test_every_age_and_both_models_are_measured():
    t = model_skill_table(seasonal_ar(), 2024)
    assert set(t.data_age_days) == set(MODE_DATA_AGES)
    assert set(t.model) == {"blend", "persistence"}


def test_blend_wins_on_a_seasonal_series():
    t = forecast_mode_table(seasonal_ar(), 2024)
    assert (t.model == "blend").all()


def test_persistence_wins_on_a_random_walk():
    t = forecast_mode_table(random_walk(), 2024)
    assert (t[t.data_age_days <= 1].model == "persistence").all()


def test_mode_describes_the_chosen_models_skill():
    t = forecast_mode_table(seasonal_ar(), 2024)
    for _, r in t.iterrows():
        want = ("forecast" if r.skill_pct >= 20 else
                "outlook" if r.skill_pct >= 5 else "seasonal_normal")
        assert r["mode"] == want


def test_blend_alpha_is_fitted_at_the_effective_horizon():
    """Audit §7.2: the alpha the skill is measured with is the alpha for
    age + h, which is what nightly now serves."""
    from scripts.forecast.baselines import climatology, fit_alpha
    s = seasonal_ar()
    train = s[s.index.year < 2024].dropna()
    clim = climatology(train)
    t = model_skill_table(s, 2024)
    row = t[(t.model == "blend") & (t.data_age_days == 3) & (t.horizon_days == 2)].iloc[0]
    assert row.alpha == fit_alpha(train, clim, 5)
