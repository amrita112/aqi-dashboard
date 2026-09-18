"""
Forecast baselines for daily city-level PM2.5, and a backtest harness.

The question this exists to answer: can we predict the next few days well
enough that a person should change their plans because of it? The honest test
is to train only on data from before a year, predict that year forward, and
compare against the two baselines any forecast must beat to be worth shipping:

  persistence   tomorrow looks like today. Strong at short range, and the
                thing a user does in their head anyway.
  climatology   tomorrow looks like this calendar day usually does. Carries
                no information about current conditions, but never drifts.

A forecast that cannot beat BOTH is not a forecast -- it is one of them
wearing a hat. The blend below is the smallest model that beats them:
predict the seasonal normal, then add back a decayed fraction of today's
departure from normal.

    forecast(t+h) = climatology(t+h) + alpha_h * (obs(t) - climatology(t))

alpha_h is fitted on the training years alone, one value per horizon, and
falls with h -- today's smog tells you a lot about tomorrow and almost
nothing about next week. That decay is the whole result: where alpha reaches
zero, the model has collapsed into climatology and the forecast is honest
only if you stop calling it one.

Used by notebooks/forecast_feasibility.ipynb and, once a live source exists,
by the nightly job that precomputes the app's forecast table.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Dict, Iterable, List, Optional

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

PROJECT_ROOT = Path(__file__).resolve().parents[2]
XKDR_GLOB = str(PROJECT_ROOT / "data" / "XKDR_data" / "data" / "v1"
                / "measurements" / "*" / "*" / "data.parquet")

# XKDR city spellings for our six target cities. Note these are XKDR's names,
# which differ from TARGET_CITIES in config.py ("Bengaluru" vs "Bangalore",
# "Delhi" vs "Delhi NCR") -- the app maps between them.
CITIES = ["Delhi", "Mumbai", "Bengaluru", "Hyderabad", "Chennai", "Kolkata"]

# The months that motivate the whole product. Delhi's PM2.5 roughly quadruples
# between its August low and its November peak; a forecast that only works in
# the clean half of the year is useless.
SEASON_MONTHS = (10, 11, 12, 1)


def load_city_daily(min_readings_per_station_day: int = 12,
                    min_stations_per_day: int = 3) -> pd.DataFrame:
    """Daily city-mean PM2.5 from the local XKDR parquet export.

    Two-step average, same convention as the rest of this project: mean per
    station-day first, then mean across stations. Averaging all raw readings
    at once would weight the city toward whichever monitor reports most often.

    The thresholds drop thin days -- a "city average" built from one station
    reporting twice is noise that would flatter every model equally.
    """
    import duckdb
    con = duckdb.connect()
    con.execute(
        f"CREATE VIEW m AS SELECT * FROM read_parquet('{XKDR_GLOB}', "
        f"hive_partitioning=true, hive_types={{'year':INTEGER,'month':INTEGER}})"
    )
    city_list = ", ".join(f"'{c}'" for c in CITIES)
    df = con.sql(f"""
        WITH station_day AS (
            SELECT city_name, station_id, CAST(collected_at AS DATE) AS d,
                   avg(value) AS v
            FROM m
            WHERE parameter_name = 'PM2.5'
              AND city_name IN ({city_list})
              AND value BETWEEN 0 AND 2000
            GROUP BY 1, 2, 3
            HAVING count(*) >= {min_readings_per_station_day}
        )
        SELECT city_name, d, avg(v) AS pm25, count(*) AS n_stations
        FROM station_day GROUP BY 1, 2
        HAVING count(*) >= {min_stations_per_day}
        ORDER BY 1, 2
    """).df()
    df["d"] = pd.to_datetime(df["d"])
    return df


def city_series(daily: pd.DataFrame, city: str) -> pd.Series:
    """One city's daily series on an explicit calendar index (gaps stay NaN)."""
    x = daily[daily.city_name == city]
    return pd.Series(x.pm25.values, index=pd.DatetimeIndex(x.d), name=city).asfreq("D")


def climatology(train: pd.Series, window: int = 15) -> pd.Series:
    """Mean PM2.5 for each day of the year, smoothed.

    Indexed 1-366. Smoothing is circular -- the profile is tripled before the
    rolling mean so that 31 December and 1 January are neighbours rather than
    the two ends of a line, which otherwise leaves a discontinuity in the
    middle of Delhi's worst weeks.
    """
    prof = (train.groupby(train.index.dayofyear).mean()
                 .reindex(range(1, 367)).interpolate(limit_direction="both"))
    smoothed = (pd.concat([prof, prof, prof])
                  .rolling(window, center=True, min_periods=1).mean()
                  .iloc[366:732])
    smoothed.index = range(1, 367)
    return smoothed


def _lagged(s: pd.Series, idx: pd.DatetimeIndex, h: int) -> pd.Series:
    """The observation h days before each timestamp in idx."""
    return pd.Series(s.reindex(idx - pd.Timedelta(days=h)).values, index=idx)


def fit_alpha(train: pd.Series, clim: pd.Series, h: int,
              grid: Optional[Iterable[float]] = None) -> float:
    """Choose the anomaly-carry weight for horizon h, on training data only.

    alpha = 1 is pure persistence-of-anomaly, alpha = 0 is pure climatology.
    Fitted here and never on the test year, so the reported skill is honest.
    """
    grid = np.arange(0, 1.001, 0.05) if grid is None else grid
    idx = train.index
    prev = _lagged(train, idx, h)
    cl_now = pd.Series(clim.reindex(idx.dayofyear).values, index=idx)
    cl_prev = pd.Series(clim.reindex((idx - pd.Timedelta(days=h)).dayofyear).values, index=idx)
    anom = prev - cl_prev
    best_a, best_e = 0.0, np.inf
    for a in grid:
        pred = cl_now + a * anom
        mask = pred.notna() & train.notna()
        if mask.sum() == 0:
            continue
        err = float(np.abs(pred[mask] - train[mask]).mean())
        if err < best_e:
            best_a, best_e = float(a), err
    return best_a


def backtest(series: pd.Series, test_year: int,
             horizons: Iterable[int] = (1, 2, 3, 4, 5, 6, 7)) -> pd.DataFrame:
    """Train on everything before test_year, predict it, score every horizon.

    Returns one tidy row per (horizon, model, subset) with MAE, RMSE, n, and
    the fitted alpha. `subset` is 'all' or 'season' (Oct-Jan).
    """
    train = series[series.index.year < test_year].dropna()
    test = series[series.index.year == test_year]
    if train.empty or test.notna().sum() == 0:
        return pd.DataFrame()

    clim = climatology(train)
    y = test.dropna()
    idx = y.index
    in_season = pd.Series(idx.month.isin(SEASON_MONTHS), index=idx)

    rows: List[Dict] = []
    for h in horizons:
        alpha = fit_alpha(train, clim, h)
        prev = _lagged(series, idx, h)
        cl_now = pd.Series(clim.reindex(idx.dayofyear).values, index=idx)
        cl_prev = pd.Series(clim.reindex((idx - pd.Timedelta(days=h)).dayofyear).values, index=idx)
        preds = {
            "persistence": prev,
            "climatology": cl_now,
            "blend":       cl_now + alpha * (prev - cl_prev),
        }
        for name, pred in preds.items():
            for subset, sel in (("all", pd.Series(True, index=idx)), ("season", in_season)):
                mask = pred.notna() & y.notna() & sel
                n = int(mask.sum())
                if n == 0:
                    continue
                err = pred[mask] - y[mask]
                rows.append({
                    "city": series.name, "test_year": test_year, "horizon": h,
                    "model": name, "subset": subset, "n": n,
                    "mae": float(np.abs(err).mean()),
                    "rmse": float(np.sqrt((err ** 2).mean())),
                    "bias": float(err.mean()), "alpha": alpha,
                })
    return pd.DataFrame(rows)


def backtest_stale_input(series: pd.Series, test_year: int,
                         data_lags: Iterable[int] = (0, 1, 2, 3, 4),
                         wants: Iterable[int] = (1, 2, 3)) -> pd.DataFrame:
    """Score the forecast when the most recent reading is already old.

    The model's only current information is the last observation. If that
    reading is `lag` days old, then forecasting `want` days into the future is
    really a (lag + want)-step problem -- the anomaly being carried forward has
    had lag+want days to decay, not want days.

    This matters because our sources differ in freshness: the OpenAQ live API
    runs about a day behind, and the S3 archive three to four days. Asking "can
    we forecast tomorrow" has a different answer for each.

    Scored over the pollution season only, and compared against climatology --
    the forecast is worth showing only while it still beats the seasonal
    average, which needs no current reading at all.
    """
    train = series[series.index.year < test_year].dropna()
    test = series[series.index.year == test_year]
    if train.empty or test.notna().sum() == 0:
        return pd.DataFrame()

    clim = climatology(train)
    y = test.dropna()
    idx = y.index
    y = y[idx.month.isin(SEASON_MONTHS)]
    idx = y.index

    cl_now = pd.Series(clim.reindex(idx.dayofyear).values, index=idx)
    clim_mae = float(np.abs(cl_now - y).mean())

    rows: List[Dict] = []
    for lag in data_lags:
        for want in wants:
            eff = lag + want          # effective horizon from the last reading
            alpha = fit_alpha(train, clim, eff)
            prev = _lagged(series, idx, eff)
            cl_prev = pd.Series(clim.reindex((idx - pd.Timedelta(days=eff)).dayofyear).values,
                                index=idx)
            pred = cl_now + alpha * (prev - cl_prev)
            mask = pred.notna() & y.notna()
            if mask.sum() == 0:
                continue
            mae = float(np.abs(pred[mask] - y[mask]).mean())
            rows.append({
                "city": series.name, "data_lag": lag, "forecast_for": want,
                "effective_horizon": eff, "alpha": alpha, "n": int(mask.sum()),
                "mae": mae, "clim_mae": clim_mae,
                "skill_vs_clim": 100 * (clim_mae - mae) / clim_mae,
                "beats_clim": mae < clim_mae,
            })
    return pd.DataFrame(rows)


def predictions_for(series: pd.Series, test_year: int, h: int) -> pd.DataFrame:
    """Actual vs each model's prediction for one horizon — for plotting."""
    train = series[series.index.year < test_year].dropna()
    test = series[series.index.year == test_year].dropna()
    clim = climatology(train)
    idx = test.index
    alpha = fit_alpha(train, clim, h)
    prev = _lagged(series, idx, h)
    cl_now = pd.Series(clim.reindex(idx.dayofyear).values, index=idx)
    cl_prev = pd.Series(clim.reindex((idx - pd.Timedelta(days=h)).dayofyear).values, index=idx)
    return pd.DataFrame({
        "actual": test,
        "persistence": prev,
        "climatology": cl_now,
        "blend": cl_now + alpha * (prev - cl_prev),
    }, index=idx)


# ─── NAQI bands ──────────────────────────────────────────────────────────────
# What a user acts on is the category, not the number. A forecast that says
# 190 when the truth is 210 is numerically off by 20 but lands in the right
# band ("Poor") and gives the right advice; one that says 90 vs 110 crosses
# from Satisfactory into Moderate and gives the wrong advice for the same
# 20 ug/m3 error. Band accuracy is therefore the metric closest to the product.

NAQI_PM25_BREAKS = [0, 30, 60, 90, 120, 250, np.inf]
NAQI_LABELS = ["Good", "Satisfactory", "Moderate", "Poor", "Very Poor", "Severe"]


def naqi_band(values) -> pd.Categorical:
    """Bucket PM2.5 concentrations into CPCB's six NAQI categories.

    Returns a Categorical (not a Series), so callers get `.codes` directly --
    the codes are ordered 0..5, which makes "within one band" a subtraction.
    """
    cut = pd.cut(pd.Series(values).reset_index(drop=True), bins=NAQI_PM25_BREAKS,
                 labels=NAQI_LABELS, right=False)
    return pd.Categorical(cut, categories=NAQI_LABELS, ordered=True)
