"""
Daily air quality forecasting on the XKDR measurements dataset.

Self-contained: pandas, numpy and duckdb, reading the parquet export directly.
Nothing here needs a database or an API key.

Set XKDR_DATA_DIR if the data is not in a `data/` directory beside this file.

Extracted from a larger application, with everything specific to that
application removed. What remains is the modelling and the backtests.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

# Where the XKDR measurements parquet lives.
#
# Defaults to a `data/` directory beside this file, which is the layout of the
# XKDR repository itself. Point XKDR_DATA_DIR somewhere else to run against a
# copy held elsewhere:
#
#     export XKDR_DATA_DIR=/path/to/xkdr/data
#
# Caches written by the loaders below land next to the data, not in the repo.
PROJECT_ROOT = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("XKDR_DATA_DIR", PROJECT_ROOT / "data"))
XKDR_GLOB = str(DATA_DIR / "v1" / "measurements" / "*" / "*" / "data.parquet")

# Our target cities, named as the analysis refers to them. These differ from
# TARGET_CITIES in config.py ("Bengaluru" vs "Bangalore", "Delhi" vs
# "Delhi NCR") -- the app maps between them.
CITIES = ["Delhi", "Mumbai", "Bengaluru", "Hyderabad", "Chennai", "Kolkata", "Pune"]

# One of our cities can span several XKDR city_name values. Pune is the case
# that forced this: our bounding box covers Pune proper and Pimpri-Chinchwad,
# which is one contiguous metro on the ground but two names in XKDR. Merging
# them matches what the app will serve.
#
# Caveat worth remembering when reading Pune's numbers: XKDR only starts
# labelling Pimpri-Chinchwad in 2023, so the merged series gains stations
# partway through. The two-step average (mean of station means, never a mean of
# raw readings) limits the damage, but Pune's early years rest on fewer
# monitors than its later ones.
XKDR_CITY_ALIASES: Dict[str, List[str]] = {
    "Pune": ["Pune", "Pimpri-Chinchwad"],
}


def xkdr_names(city: str) -> List[str]:
    """XKDR city_name values that make up one of our cities."""
    return XKDR_CITY_ALIASES.get(city, [city])


def _city_sql_case() -> str:
    """SQL fragment folding XKDR city names into our city names."""
    whens = []
    for city in CITIES:
        names = ", ".join(f"'{n}'" for n in xkdr_names(city))
        whens.append(f"WHEN city_name IN ({names}) THEN '{city}'")
    return "CASE " + " ".join(whens) + " END"


def _all_xkdr_names() -> str:
    names = {n for c in CITIES for n in xkdr_names(c)}
    return ", ".join(f"'{n}'" for n in sorted(names))

# The months that motivate the whole product. Delhi's PM2.5 roughly quadruples
# between its August low and its November peak; a forecast that only works in
# the clean half of the year is useless.
SEASON_MONTHS = (10, 11, 12, 1)


def load_city_daily(parameter = "PM2.5", min_readings_per_station_day: int = 12,
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
    # Assert parameter from existing XKDR parameter_name values, to avoid a silent empty return if the caller misspells it.
    if parameter not in {"PM2.5", "PM10", "NO2", "SO2", "O3", "CO"}:
        raise ValueError(f"parameter {parameter!r} not in XKDR parameter_name values")
    df = con.sql(f"""
        WITH station_day AS (
            SELECT {_city_sql_case()} AS city_name, station_id,
                   CAST(collected_at AS DATE) AS d, avg(value) AS v
            FROM m
            WHERE parameter_name = '{parameter}'
              AND city_name IN ({_all_xkdr_names()})
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


# The four pollutants NAQI is driven by in this dataset. O3 and CO are part of
# the CPCB standard but are not present here.
MEASURED_POLLUTANTS = ("pm25", "pm10", "no2", "so2")


# ─── Hourly series and the diurnal shape ─────────────────────────────────────

CITY_HOURLY_CACHE = DATA_DIR / "cache_xkdr_city_hourly.parquet"


def load_city_hourly(rebuild: bool = False, min_stations: int = 3,
                     since: str = "2019-01-01") -> pd.DataFrame:
    """Hourly city-mean PM2.5, cached as parquet.

    Same two-step averaging as the daily loader, one level finer: mean across
    the stations reporting in that hour. Hours backed by fewer than
    `min_stations` are dropped, because a "city average" resting on one monitor
    is that monitor, not the city.
    """
    import duckdb

    if CITY_HOURLY_CACHE.exists() and not rebuild:
        df = pd.read_parquet(CITY_HOURLY_CACHE)
    else:
        con = duckdb.connect()
        con.execute(
            f"CREATE VIEW m AS SELECT * FROM read_parquet('{XKDR_GLOB}', "
            f"hive_partitioning=true, hive_types={{'year':INTEGER,'month':INTEGER}})"
        )
        con.execute(f"""COPY (
            SELECT {_city_sql_case()} AS city, collected_at AS ts,
                   CAST(collected_at AS DATE) AS d,
                   EXTRACT(hour FROM collected_at)::INTEGER AS hr,
                   EXTRACT(month FROM collected_at)::INTEGER AS mo,
                   avg(value) AS pm25, count(*) AS n_st
            FROM m
            WHERE parameter_name = 'PM2.5' AND city_name IN ({_all_xkdr_names()})
              AND value BETWEEN 0 AND 2000 AND collected_at >= '{since}'
            GROUP BY 1,2,3,4,5 HAVING count(*) >= {min_stations}
        ) TO '{CITY_HOURLY_CACHE}' (FORMAT PARQUET, COMPRESSION ZSTD)""")
        df = pd.read_parquet(CITY_HOURLY_CACHE)

    df["ts"] = pd.to_datetime(df["ts"])
    df["d"] = pd.to_datetime(df["d"])
    return df


CITY_HOURLY_AQI_CACHE = DATA_DIR / "cache_xkdr_city_hourly_aqi.parquet"


def load_city_hourly_aqi(rebuild: bool = False, min_stations: int = 3,
                         since: str = "2019-01-01") -> pd.DataFrame:
    """Hourly city-mean composite NAQI, cached as parquet.

    The AQI twin of load_city_hourly, and the input the AQI diurnal shape is
    fitted on. Built the same way NAQI is defined everywhere else in this
    module: average each pollutant over the HOUR at each station, convert each
    to its sub-index, take the max across pollutants, then average those
    station sub-indices across the city.

    Taking the max per station-hour before averaging matters. Averaging the
    pollutants across stations first and taking the max afterwards would be a
    different number, and a smoother one -- the max is where AQI gets its
    character.
    """
    import duckdb
    from aqi_utils import compute_subindex

    if CITY_HOURLY_AQI_CACHE.exists() and not rebuild:
        df = pd.read_parquet(CITY_HOURLY_AQI_CACHE)
        df["d"] = pd.to_datetime(df["d"])
        return df

    con = duckdb.connect()
    con.execute(
        f"CREATE VIEW m AS SELECT * FROM read_parquet('{XKDR_GLOB}', "
        f"hive_partitioning=true, hive_types={{'year':INTEGER,'month':INTEGER}})"
    )
    sh = con.sql(f"""
        SELECT {_city_sql_case()} AS city, station_id AS station,
               CAST(collected_at AS DATE) AS d,
               EXTRACT(hour FROM collected_at)::INTEGER AS hr,
               EXTRACT(month FROM collected_at)::INTEGER AS mo,
               CASE parameter_name WHEN 'PM2.5' THEN 'pm25' WHEN 'PM10' THEN 'pm10'
                    WHEN 'NO2' THEN 'no2' WHEN 'SO2' THEN 'so2' END AS pollutant,
               avg(value) AS v
        FROM m
        WHERE parameter_name IN ('PM2.5','PM10','NO2','SO2')
          AND city_name IN ({_all_xkdr_names()})
          AND value BETWEEN 0 AND 2000 AND collected_at >= '{since}'
        GROUP BY 1,2,3,4,5,6
    """).df()

    sh["si"] = [compute_subindex(p, v) for p, v in zip(sh.pollutant, sh.v)]
    station_hour = (sh.groupby(["city", "station", "d", "hr", "mo"], as_index=False)["si"]
                      .max())
    out = (station_hour.groupby(["city", "d", "hr", "mo"], as_index=False)
                       .agg(aqi=("si", "mean"), n_st=("station", "nunique")))
    out = out[out.n_st >= min_stations]
    out["d"] = pd.to_datetime(out["d"])
    CITY_HOURLY_AQI_CACHE.parent.mkdir(parents=True, exist_ok=True)
    out.to_parquet(CITY_HOURLY_AQI_CACHE, index=False)
    return out


def complete_days(g: pd.DataFrame, min_hours: int = 20,
                  value_col: str = "pm25") -> pd.DataFrame:
    """Keep only days with enough hours for a daily mean to mean anything."""
    return g[g.groupby("d")[value_col].transform("size") >= min_hours]


def diurnal_shape(train: pd.DataFrame, value_col: str = "pm25") -> pd.Series:
    """Mean ratio of hourly value to that day's mean, per (month, hour).

    A RATIO rather than an absolute profile, so the shape scales with the
    level: one learned in a clean month still applies in a dirty one. Indexed
    by (month, hour); multiply a daily forecast by it to get an hourly one.

    `value_col` exists because AQI needs its own shape. AQI is the max of four
    sub-indices, and the pollutant that wins can change with the hour, so its
    daily profile is not PM2.5's. Before this was parametrised, fit_city simply
    skipped shape fitting for AQI and every hourly AQI forecast was the daily
    number repeated 24 times.
    """
    day_mean = train.groupby("d")[value_col].transform("mean")
    ok = day_mean > 1                      # avoid dividing by ~0 on clean days
    t = train[ok].assign(ratio=train.loc[ok, value_col] / day_mean[ok])
    return t.groupby(["mo", "hr"])["ratio"].mean()


def variance_decomposition(g: pd.DataFrame) -> Dict[str, float]:
    """Split hourly variance into day-level, diurnal, and residual shares."""
    g = complete_days(g)
    day_mean = g.groupby("d")["pm25"].transform("mean")
    g = g[day_mean > 1]
    day_mean = day_mean[day_mean > 1]
    shape = diurnal_shape(g)
    pred = day_mean.values * g.set_index(["mo", "hr"]).index.map(shape).values
    total = g["pm25"].var()
    resid = float(np.var(g["pm25"].values - pred))
    day = float(day_mean.var())
    return {"day": day / total, "diurnal": 1 - day / total - resid / total,
            "residual": resid / total}


def backtest_hour(g: pd.DataFrame, test_year: int,
                  hours: Iterable[int] = (9, 15, 18)) -> pd.DataFrame:
    """Compare ways of forecasting a NAMED hour one day ahead.

    flat        - quote the day's forecast for every hour (no shape at all)
    shape       - day forecast x climatological diurnal shape
    same_hour   - yesterday's value at this same hour
    hour_clim   - the historical mean for this (month, hour)

    The day forecast used here is persistence of the daily mean, so the
    comparison isolates the HOUR treatment rather than re-testing the daily
    model. Scored over the pollution season only.
    """
    g = complete_days(g).sort_values("ts")
    daily = g.groupby("d")["pm25"].mean()
    train = g[g["d"].dt.year < test_year]
    if train.empty:
        return pd.DataFrame()

    shape = diurnal_shape(train)
    hour_clim = train.groupby(["mo", "hr"])["pm25"].mean()
    by_ts = g.set_index("ts")["pm25"]

    test = g[(g["d"].dt.year == test_year) & (g["mo"].isin(SEASON_MONTHS))]
    rows: List[Dict] = []
    for hour in hours:
        sub = test[test.hr == hour]
        if len(sub) < 30:
            continue
        prev_daily = daily.reindex(sub["d"] - pd.Timedelta(days=1)).values
        preds = {
            "flat":      prev_daily,
            "shape":     prev_daily * np.array([shape.get((m, hour), 1.0)
                                                for m in sub["mo"].values]),
            "same_hour": by_ts.reindex(sub["ts"] - pd.Timedelta(days=1)).values,
            "hour_clim": np.array([hour_clim.get((m, hour), np.nan)
                                   for m in sub["mo"].values]),
        }
        y = sub["pm25"].values
        for name, p in preds.items():
            mask = ~np.isnan(p) & ~np.isnan(y)
            if mask.sum() < 10:
                continue
            rows.append({"city": g["city"].iloc[0], "hour": hour, "model": name,
                         "n": int(mask.sum()),
                         "mae": float(np.abs(p[mask] - y[mask]).mean())})
    return pd.DataFrame(rows)


def best_hour_eval(g: pd.DataFrame, test_year: int, n_pick: int = 3,
                   day_window: Tuple[int, int] = (6, 21)) -> Optional[Dict[str, float]]:
    """Does the shape's "cleanest hours" advice actually pick clean hours?

    Takes the `n_pick` lowest-ratio daytime hours from the climatological
    shape, then looks up where those hours really ranked that day. Reports the
    mean rank (against a random-choice baseline), how often a pick lands in the
    day's true best five, and the concentration avoided versus just going out
    at an average time -- which is the number a user actually feels.
    """
    g = complete_days(g).sort_values("ts")
    train = g[g["d"].dt.year < test_year]
    if train.empty:
        return None
    shape = diurnal_shape(train)

    lo, hi = day_window
    test = g[(g["d"].dt.year == test_year) & (g["mo"].isin(SEASON_MONTHS))
             & (g.hr.between(lo, hi))]
    ranks, in_best5, saved, n_slots = [], [], [], []
    for _, day in test.groupby("d"):
        if len(day) < (hi - lo):
            continue
        mo = int(day["mo"].iloc[0])
        sh = {int(h): shape.get((mo, int(h)), np.nan) for h in day.hr}
        if any(np.isnan(v) for v in sh.values()):
            continue
        picks = sorted(sh, key=lambda k: sh[k])[:n_pick]
        actual = day.set_index("hr")["pm25"]
        order = actual.rank()
        n_slots.append(len(actual))
        for h in picks:
            if h in order.index:
                ranks.append(float(order[h]))
                in_best5.append(bool(order[h] <= 5))
        saved.append(float(actual.mean() - actual.reindex(picks).mean()))
    if not ranks:
        return None
    return {"mean_rank": float(np.mean(ranks)),
            "random_rank": (float(np.mean(n_slots)) + 1) / 2,
            "pct_in_best5": 100 * float(np.mean(in_best5)),
            "ugm3_saved": float(np.mean(saved)),
            "n_days": len(saved)}


def backtest_anomaly_window(series: pd.Series, test_year: int,
                            windows: Iterable[int] = (1, 2, 3, 5, 7, 14, 30),
                            horizon: int = 1) -> pd.DataFrame:
    """How many recent days should the anomaly be averaged over?

    The model carries forward the latest departure from the seasonal normal.
    This asks whether averaging that departure over several recent days is
    steadier than taking the single freshest one. Alpha is refitted per window
    on training years only, so each window is judged at its own best setting.
    """
    train = series[series.index.year < test_year].dropna()
    test = series[series.index.year == test_year].dropna()
    test = test[test.index.month.isin(SEASON_MONTHS)]
    if train.empty or len(test) < 60:
        return pd.DataFrame()

    clim = climatology(train)

    def mean_anomaly(idx: pd.DatetimeIndex, n: int) -> pd.Series:
        parts = []
        for lag in range(horizon, horizon + n):
            prev = _lagged(series, idx, lag)
            cl_prev = pd.Series(
                clim.reindex((idx - pd.Timedelta(days=lag)).dayofyear).values, index=idx)
            parts.append(prev - cl_prev)
        return pd.concat(parts, axis=1).mean(axis=1, skipna=True)

    rows: List[Dict] = []
    for n in windows:
        t_anom = mean_anomaly(train.index, n)
        t_cl = pd.Series(clim.reindex(train.index.dayofyear).values, index=train.index)
        best_a, best_e = 0.0, np.inf
        for a in np.arange(0, 1.001, 0.05):
            p = t_cl + a * t_anom
            m = p.notna() & train.notna()
            if m.sum() == 0:
                continue
            e = float(np.abs(p[m] - train[m]).mean())
            if e < best_e:
                best_a, best_e = float(a), e

        cl_now = pd.Series(clim.reindex(test.index.dayofyear).values, index=test.index)
        pred = cl_now + best_a * mean_anomaly(test.index, n)
        m = pred.notna() & test.notna()
        if m.sum() == 0:
            continue
        rows.append({"city": series.name, "window_days": n, "alpha": best_a,
                     "n": int(m.sum()),
                     "mae": float(np.abs(pred[m] - test[m]).mean())})
    return pd.DataFrame(rows)


def gap_stats(series: pd.Series, since: str = "2019-01-01",
              ignore_runs_over: int = 30) -> Dict[str, float]:
    """How far back must we look to find a reading?

    Sets the raw-retention floor: the forecast reads one day, but only if one
    is there. Runs longer than `ignore_runs_over` are excluded as outages
    rather than normal behaviour -- the XKDR export is missing all of Q1 2025,
    which would otherwise dominate the percentiles.
    """
    s = series[series.index >= since]
    present = s.notna()
    back, last = [], None
    for ts, ok in present.items():
        if ok:
            last = ts
        if last is not None:
            back.append((ts - last).days)
    normal = [b for b in back if b <= ignore_runs_over]
    if not normal:
        return {}
    return {"p50": float(np.percentile(normal, 50)),
            "p90": float(np.percentile(normal, 90)),
            "p99": float(np.percentile(normal, 99)),
            "p999": float(np.percentile(normal, 99.9)),
            "missing_days": int((~present).sum()), "total_days": int(len(s))}


# ─── Station granularity ─────────────────────────────────────────────────────
#
# Every backtest above works on a CITY average over tens of stations. The app
# serves whatever is near the user, which is a handful of stations at most.
# These functions ask whether the skill survives that shrink -- and they exist
# as functions rather than a one-off script because the answer decides what the
# forecast service stores.

STATION_DAILY_CACHE = DATA_DIR / "cache_xkdr_station_daily.parquet"


def load_station_daily(rebuild: bool = False, min_readings_per_day: int = 12,
                       since: str = "2019-01-01") -> pd.DataFrame:
    """Daily mean PM2.5 per STATION (not per city), cached as parquet."""
    import duckdb

    if STATION_DAILY_CACHE.exists() and not rebuild:
        df = pd.read_parquet(STATION_DAILY_CACHE)
    else:
        con = duckdb.connect()
        con.execute(
            f"CREATE VIEW m AS SELECT * FROM read_parquet('{XKDR_GLOB}', "
            f"hive_partitioning=true, hive_types={{'year':INTEGER,'month':INTEGER}})"
        )
        con.execute(f"""COPY (
            SELECT {_city_sql_case()} AS city, station_id AS station,
                   CAST(collected_at AS DATE) AS d, avg(value) AS v
            FROM m
            WHERE parameter_name = 'PM2.5' AND city_name IN ({_all_xkdr_names()})
              AND value BETWEEN 0 AND 2000 AND collected_at >= '{since}'
            GROUP BY 1,2,3 HAVING count(*) >= {min_readings_per_day}
        ) TO '{STATION_DAILY_CACHE}' (FORMAT PARQUET, COMPRESSION ZSTD)""")
        df = pd.read_parquet(STATION_DAILY_CACHE)

    df["d"] = pd.to_datetime(df["d"])
    return df


STATION_AQI_CACHE = DATA_DIR / "cache_xkdr_station_daily_aqi.parquet"


def load_station_daily_aqi(rebuild: bool = False, min_readings_per_day: int = 12,
                           since: str = "2019-01-01") -> pd.DataFrame:
    """Daily composite NAQI per STATION, cached as parquet.

    The parquet twin of the `station_aqi` frame load_history_from_db returns,
    and the AQI counterpart of load_station_daily. Columns are deliberately
    identical to that function's (city, station, d, v) so fit_stations() can
    take either without knowing which pollutant it is fitting.

    Why this has to exist separately: AQI is the MAX of four sub-indices, not a
    mean of one series, so it cannot be derived from the PM2.5 station frame
    after the fact. Fitting a station's AQI climatology on its PM2.5 history --
    which is what happened before this function existed -- understates Delhi's
    September climatology by roughly half (57 fitted against 95-107 observed).
    """
    import duckdb
    from aqi_utils import compute_subindex

    if STATION_AQI_CACHE.exists() and not rebuild:
        df = pd.read_parquet(STATION_AQI_CACHE)
        df["d"] = pd.to_datetime(df["d"])
        return df

    con = duckdb.connect()
    con.execute(
        f"CREATE VIEW m AS SELECT * FROM read_parquet('{XKDR_GLOB}', "
        f"hive_partitioning=true, hive_types={{'year':INTEGER,'month':INTEGER}})"
    )
    sd = con.sql(f"""
        SELECT {_city_sql_case()} AS city, station_id AS station,
               CAST(collected_at AS DATE) AS d,
               CASE parameter_name WHEN 'PM2.5' THEN 'pm25' WHEN 'PM10' THEN 'pm10'
                    WHEN 'NO2' THEN 'no2' WHEN 'SO2' THEN 'so2' END AS pollutant,
               avg(value) AS v
        FROM m
        WHERE parameter_name IN ('PM2.5','PM10','NO2','SO2')
          AND city_name IN ({_all_xkdr_names()})
          AND value BETWEEN 0 AND 2000 AND collected_at >= '{since}'
        GROUP BY 1,2,3,4
        HAVING count(*) >= {min_readings_per_day}
    """).df()

    sd["subindex"] = [compute_subindex(p, v) for p, v in zip(sd.pollutant, sd.v)]
    sd = sd.dropna(subset=["subindex"])

    # CPCB's definition: per station-day, the max sub-index across pollutants.
    out = (sd.groupby(["city", "station", "d"], as_index=False)["subindex"]
             .max().rename(columns={"subindex": "v"}))
    out["d"] = pd.to_datetime(out["d"])
    STATION_AQI_CACHE.parent.mkdir(parents=True, exist_ok=True)
    out.to_parquet(STATION_AQI_CACHE, index=False)
    return out


def _as_series(df: pd.DataFrame, name: str = "") -> pd.Series:
    """Collapse station-days to one daily series on an explicit calendar index."""
    s = df.groupby("d")["v"].mean()
    s = s.asfreq("D") if len(s) else s
    s.name = name
    return s


def evaluate_series(s: pd.Series, test_year: int, min_train_days: int = 300,
                    min_test_days: int = 40) -> Optional[Dict[str, Any]]:
    """Fit and score the standalone +1-day model on any daily series.

    Works the same whether `s` is a city average, a k-station aggregate or one
    station, which is what makes the granularity comparison apples-to-apples.
    Also reports how often the day the model depends on -- yesterday -- is
    simply absent, because that is the failure mode that gets worse as the
    aggregate shrinks.
    """
    train = s[s.index.year < test_year].dropna()
    test = s[s.index.year == test_year].dropna()
    test = test[test.index.month.isin(SEASON_MONTHS)]
    if len(train) < min_train_days or len(test) < min_test_days:
        return None

    clim = climatology(train)
    alpha = fit_alpha(train, clim, 1)
    idx = test.index
    prev = _lagged(s, idx, 1)
    cl_now = pd.Series(clim.reindex(idx.dayofyear).values, index=idx)
    cl_prev = pd.Series(clim.reindex((idx - pd.Timedelta(days=1)).dayofyear).values, index=idx)

    out: Dict[str, Any] = {"name": s.name, "n_test": len(test), "alpha": alpha,
                           "level": float(test.mean()),
                           "pct_yesterday_missing": 100 * float(prev.isna().mean())}
    for key, pred in (("blend", cl_now + alpha * (prev - cl_prev)),
                      ("persist", prev), ("clim", cl_now)):
        mask = pred.notna() & test.notna()
        out["mae_" + key] = (float(np.abs(pred[mask] - test[mask]).mean())
                             if mask.sum() > 20 else np.nan)
    out["skill"] = (100 * (out["mae_clim"] - out["mae_blend"]) / out["mae_clim"]
                    if out["mae_clim"] == out["mae_clim"] else np.nan)
    return out


def backtest_granularity(station_daily: pd.DataFrame, test_year: int,
                         ks: Iterable[int] = (3, 5, 10), trials: int = 8,
                         min_station_days: int = 500, seed: int = 0) -> pd.DataFrame:
    """Score the same model at city, k-station and single-station granularity.

    The k-station groups are RANDOM subsets rather than true geographic
    neighbours. That is deliberate and conservative: real neighbours correlate
    more with each other, so they average away slightly less noise than a
    random set -- meaning the true k-nearest result should be no worse than
    this. Geography would also make the subset more representative of the
    user's own air, which this cannot measure.
    """
    rng = np.random.default_rng(seed)
    rows: List[Dict[str, Any]] = []

    for city, g in station_daily.groupby("city"):
        city_row = evaluate_series(_as_series(g, f"{city} :: CITY"), test_year)
        if city_row:
            rows.append({**city_row, "city": city, "kind": "city", "k": np.inf})

        counts = g.groupby("station").size()
        stations = [st for st in counts.index if counts[st] >= min_station_days]

        for st in stations:
            r = evaluate_series(_as_series(g[g.station == st], f"{city} :: {st}"), test_year)
            if r:
                rows.append({**r, "city": city, "kind": "station", "k": 1})

        for k in ks:
            if len(stations) < k:
                continue
            for t in range(trials):
                pick = rng.choice(stations, size=k, replace=False)
                r = evaluate_series(
                    _as_series(g[g.station.isin(pick)], f"{city} :: k={k} #{t}"), test_year)
                if r:
                    rows.append({**r, "city": city, "kind": f"k={k}", "k": k})
    return pd.DataFrame(rows)


def residual_bands(series: pd.Series, test_year: int,
                   horizons: Iterable[int] = (1, 2, 3),
                   quantiles: Iterable[int] = (50, 80, 90)) -> pd.DataFrame:
    """Uncertainty bands, as a RATIO of the forecast rather than a width.

    A ratio because one number then serves Delhi at 200 ug/m3 and Bengaluru at
    30; absolute widths would need a table per level and would look absurd on
    whichever city they were not tuned for.
    """
    train = series[series.index.year < test_year].dropna()
    test = series[series.index.year == test_year].dropna()
    test = test[test.index.month.isin(SEASON_MONTHS)]
    if len(train) < 300 or len(test) < 40:
        return pd.DataFrame()

    clim = climatology(train)
    idx = test.index
    rows: List[Dict[str, Any]] = []
    for h in horizons:
        alpha = fit_alpha(train, clim, h)
        prev = _lagged(series, idx, h)
        cl_now = pd.Series(clim.reindex(idx.dayofyear).values, index=idx)
        cl_prev = pd.Series(clim.reindex((idx - pd.Timedelta(days=h)).dayofyear).values, index=idx)
        pred = cl_now + alpha * (prev - cl_prev)
        m = pred.notna() & test.notna() & (pred > 0)
        if m.sum() < 20:
            continue
        rel = (np.abs(pred[m] - test[m]) / pred[m]).values
        row = {"city": series.name, "horizon": h, "n": int(m.sum()),
               "mae": float(np.abs(pred[m] - test[m]).mean())}
        for q in quantiles:
            row[f"p{q}"] = float(np.percentile(rel, q))
        rows.append(row)
    return pd.DataFrame(rows)


# ─── Serving mode: what to show given how old the data is ────────────────────
#
# OpenAQ's publication lag is not a constant. It has been measured at 17h, 28h
# and 83h on different days, and a station can go quiet for a week. So the app
# cannot decide once whether it is "showing a forecast" -- it has to decide per
# station, per request, from the age of that station's freshest reading.
#
# The rule is not a guess: the tables below come from the same backtest as
# everything else, scoring the forecast at every combination of input age and
# horizon, and comparing it to climatology -- which needs no recent data at all
# and is therefore the thing to fall back to.

# Skill below this is not worth calling a forecast. At 0% the model is exactly
# the seasonal average computed the long way round; a few points above that is
# within the noise of the backtest itself.
MIN_USEFUL_SKILL_PCT = 5.0


def forecast_mode_table(series: pd.Series, test_year: int,
                        data_ages: Iterable[int] = (0, 1, 2, 3, 4, 5, 7),
                        horizons: Iterable[int] = (1, 2, 3),
                        quantiles: Iterable[int] = (50, 80)) -> pd.DataFrame:
    """Expected error and serving mode for each (data age, horizon) pair.

    Returns one row per combination with the mode the app should use:

      forecast         - beats climatology comfortably; show it as a forecast
      outlook          - still beats climatology, but show a wide band and
                         softer language
      seasonal_normal  - no better than the long-run average, so say that
                         instead of dressing an average up as a prediction

    The band columns are RATIOS of the forecast, so one number works at Delhi's
    200 ug/m3 and Bengaluru's 30.
    """
    train = series[series.index.year < test_year].dropna()
    test = series[series.index.year == test_year].dropna()
    test = test[test.index.month.isin(SEASON_MONTHS)]
    if len(train) < 300 or len(test) < 40:
        return pd.DataFrame()

    clim = climatology(train)
    idx = test.index
    cl_now = pd.Series(clim.reindex(idx.dayofyear).values, index=idx)
    mask_clim = cl_now.notna() & test.notna()
    clim_mae = float(np.abs(cl_now[mask_clim] - test[mask_clim]).mean())

    rows: List[Dict[str, Any]] = []
    for age in data_ages:
        for h in horizons:
            # The model's information is `age + h` days old by the time the
            # forecast lands, because the anomaly it carries forward was
            # measured `age` days ago.
            effective = age + h
            alpha = fit_alpha(train, clim, effective)
            prev = _lagged(series, idx, effective)
            cl_prev = pd.Series(
                clim.reindex((idx - pd.Timedelta(days=effective)).dayofyear).values, index=idx)
            pred = cl_now + alpha * (prev - cl_prev)
            m = pred.notna() & test.notna()
            if m.sum() < 20:
                continue
            err = np.abs(pred[m] - test[m])
            mae = float(err.mean())
            skill = 100 * (clim_mae - mae) / clim_mae

            if skill >= 20:
                mode = "forecast"
            elif skill >= MIN_USEFUL_SKILL_PCT:
                mode = "outlook"
            else:
                mode = "seasonal_normal"

            row = {"city": series.name, "data_age_days": age, "horizon_days": h,
                   "effective_horizon": effective, "alpha": alpha,
                   "mae": mae, "clim_mae": clim_mae, "skill_pct": skill,
                   "mode": mode, "n": int(m.sum())}
            # Band as a fraction of the prediction, guarding against the
            # near-zero predictions that would otherwise produce absurd ratios.
            safe = pred[m] > 1
            if safe.sum() > 20:
                rel = (err[safe] / pred[m][safe]).values
                for q in quantiles:
                    row[f"band_p{q}"] = float(np.percentile(rel, q))
            rows.append(row)
    return pd.DataFrame(rows)


def station_mode_table(station_daily: pd.DataFrame, city: str, test_year: int,
                       min_history: int = 365,
                       data_ages: Iterable[int] = (0, 1, 2, 3, 4, 5, 7),
                       horizons: Iterable[int] = (1, 2, 3)) -> pd.DataFrame:
    """forecast_mode_table, but measured on STATIONS rather than the city mean.

    The mode decides whether the app calls a number a forecast or admits it is
    the seasonal average. It is served per station, so it has to be measured
    per station. A city mean is far more predictable than any monitor in it --
    averaging ~70 Delhi stations cancels local noise, and for AQI it also
    cancels the max-over-pollutants operator jumping between pollutants -- so a
    city-fitted table says "forecast" at data ages where no individual station
    has any skill left.

    Each station gets its own table; the city's row is the MEDIAN skill across
    stations, with the mode re-derived from that median. Median rather than
    mean so one erratic monitor cannot drag a whole city's labelling.
    """
    per_station = []
    for st, sub in station_daily[station_daily.city == city].groupby("station"):
        s = sub.groupby("d")["v"].mean().asfreq("D")
        if s.dropna().shape[0] < min_history:
            continue
        s.name = city
        t = forecast_mode_table(s, test_year, data_ages=data_ages, horizons=horizons)
        if not t.empty:
            per_station.append(t)

    if not per_station:
        return pd.DataFrame()

    allt = pd.concat(per_station, ignore_index=True)
    agg = (allt.groupby(["data_age_days", "horizon_days"], as_index=False)
               .agg(effective_horizon=("effective_horizon", "first"),
                    alpha=("alpha", "median"),
                    mae=("mae", "median"),
                    clim_mae=("clim_mae", "median"),
                    skill_pct=("skill_pct", "median"),
                    band_p50=("band_p50", "median"),
                    band_p80=("band_p80", "median"),
                    n=("n", "sum"),
                    n_stations=("mae", "size")))
    agg["city"] = city
    agg["mode"] = np.where(agg.skill_pct >= 20, "forecast",
                  np.where(agg.skill_pct >= MIN_USEFUL_SKILL_PCT, "outlook",
                           "seasonal_normal"))
    return agg


def max_useful_age(mode_table: pd.DataFrame, horizon: int = 1) -> Optional[int]:
    """Oldest input age at which `horizon` is still worth calling a forecast."""
    d = mode_table[(mode_table.horizon_days == horizon)
                   & (mode_table["mode"] != "seasonal_normal")]
    return int(d.data_age_days.max()) if len(d) else None


# ─── Composite AQI ───────────────────────────────────────────────────────────
#
# Everything above forecasts PM2.5. The app shows NAQI, which is the MAX of the
# per-pollutant sub-indices -- a non-linear function of four series rather than
# one. PM2.5 usually dominates in Indian cities, so AQI should mostly track it,
# but "mostly" is an assumption worth measuring: a max is a different animal
# from a mean, and it can jump between pollutants day to day.

CITY_AQI_CACHE = DATA_DIR / "cache_xkdr_city_daily_aqi.parquet"


def load_city_daily_aqi(rebuild: bool = False, min_stations: int = 3,
                        since: str = "2019-01-01") -> pd.DataFrame:
    """Daily city-level composite NAQI, and the pollutant that drove it.

    Built the way CPCB defines it: average each pollutant over the day at each
    station, convert each to its sub-index, take the max. Station sub-indices
    are then averaged across the city, consistent with how the PM2.5 series is
    built -- averaging the raw AQI values instead would let one station's spike
    set the whole city's number.

    Keeps `dominant` (which pollutant produced the max) because how often that
    switches decides whether a single-pollutant model can stand in for AQI.
    """
    import duckdb
    from aqi_utils import compute_subindex

    if CITY_AQI_CACHE.exists() and not rebuild:
        df = pd.read_parquet(CITY_AQI_CACHE)
        df["d"] = pd.to_datetime(df["d"])
        return df

    con = duckdb.connect()
    con.execute(
        f"CREATE VIEW m AS SELECT * FROM read_parquet('{XKDR_GLOB}', "
        f"hive_partitioning=true, hive_types={{'year':INTEGER,'month':INTEGER}})"
    )
    # Station x pollutant x day means -- the input NAQI is defined on.
    sd = con.sql(f"""
        SELECT {_city_sql_case()} AS city, station_id AS station,
               CAST(collected_at AS DATE) AS d,
               CASE parameter_name WHEN 'PM2.5' THEN 'pm25' WHEN 'PM10' THEN 'pm10'
                    WHEN 'NO2' THEN 'no2' WHEN 'SO2' THEN 'so2' END AS pollutant,
               avg(value) AS v
        FROM m
        WHERE parameter_name IN ('PM2.5','PM10','NO2','SO2')
          AND city_name IN ({_all_xkdr_names()})
          AND value BETWEEN 0 AND 2000 AND collected_at >= '{since}'
        GROUP BY 1,2,3,4
        HAVING count(*) >= 12
    """).df()

    sd["subindex"] = [compute_subindex(p, v) for p, v in zip(sd.pollutant, sd.v)]
    sd = sd.dropna(subset=["subindex"])

    # Per station-day: the max sub-index is the AQI, and the pollutant that
    # produced it is the dominant one.
    idx = sd.groupby(["city", "station", "d"])["subindex"].idxmax()
    station_aqi = sd.loc[idx, ["city", "station", "d", "subindex", "pollutant"]]
    station_aqi = station_aqi.rename(columns={"subindex": "aqi", "pollutant": "dominant"})

    # Across stations, as for PM2.5.
    out = (station_aqi.groupby(["city", "d"])
                      .agg(aqi=("aqi", "mean"),
                           n_stations=("station", "nunique"),
                           dominant=("dominant", lambda s: s.value_counts().idxmax()))
                      .reset_index())
    out = out[out.n_stations >= min_stations]
    out["d"] = pd.to_datetime(out["d"])
    CITY_AQI_CACHE.parent.mkdir(parents=True, exist_ok=True)
    out.to_parquet(CITY_AQI_CACHE, index=False)
    return out


def aqi_series(daily_aqi: pd.DataFrame, city: str) -> pd.Series:
    """One city's daily composite AQI on an explicit calendar index."""
    x = daily_aqi[daily_aqi.city == city]
    s = pd.Series(x.aqi.values, index=pd.DatetimeIndex(x.d), name=city)
    return s.asfreq("D")


# ─── NAQI bands ──────────────────────────────────────────────────────────────
# What a user acts on is the category, not the number. A forecast that says
# 190 when the truth is 210 is numerically off by 20 but lands in the right
# band ("Poor") and gives the right advice; one that says 90 vs 110 crosses
# from Satisfactory into Moderate and gives the wrong advice for the same
# 20 ug/m3 error. Band accuracy is therefore the metric closest to the product.

# PM2.5 breakpoints for the six NAQI bands, from CPCB's 2014 notification.
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

# Composite AQI bands
NAQI_AQI_BANDS = [0, 51, 101, 201, 301, 401, np.inf]
def naqi_band_aqi(values) -> pd.Categorical:
    """Bucket AQI values into CPCB's six NAQI categories.

    Returns a Categorical (not a Series), so callers get `.codes` directly --
    the codes are ordered 0..5, which makes "within one band" a subtraction.
    """
    cut = pd.cut(pd.Series(values).reset_index(drop=True), bins=NAQI_AQI_BANDS,
                 labels=NAQI_LABELS, right=False)
    return pd.Categorical(cut, categories=NAQI_LABELS, ordered=True)

# ─── Per-station backtesting ─────────────────────────────────────────────────
#
# Everything above fits and scores the CITY AVERAGE. That is not the problem the
# app has. The app serves a place -- a few stations around a point the user
# picked -- and it is never going to serve a forecast trained on a 70-station
# mean, so a number measured that way overstates what anyone actually gets.
#
# The two are not merely different in practice; one bounds the other. For truth
# y_i and prediction yhat_i at station i:
#
#     |mean(yhat) - mean(y)|  <=  mean(|yhat_i - y_i|)
#
# by the triangle inequality. Averaging before taking the absolute value lets
# errors at different stations cancel, so the city-average MAE can never be the
# larger of the two, however bad the model is.
#
# Measured on composite AQI, Oct-Jan 2024, day+1: the city-average figure is
# 40.4 against 49.3 per station in Delhi, 15.3 against 21.5 in Mumbai, 12.5
# against 16.4 in Bengaluru -- roughly 71-82% of the honest number. Band
# agreement is distorted further, because banding is a threshold and
# cancellation helps it more: Mumbai reads 85% city-wide and 72% per station.
#
# These functions return exactly the shapes their city-level counterparts do, so
# a caller swaps one for the other and every downstream table and figure keeps
# working.

STATION_MIN_HISTORY_DAYS = 365
STATION_MIN_TEST_DAYS = 30


def _station_series(frame: pd.DataFrame, city: str) -> Dict[str, pd.Series]:
    """One daily series per station in a city, on an explicit calendar index."""
    out: Dict[str, pd.Series] = {}
    g = frame[frame.city == city]
    for station, sub in g.groupby("station"):
        s = sub.groupby("d")["v"].mean().asfreq("D")
        s.name = city
        out[str(station)] = s
    return out


def backtest_stations(frame: pd.DataFrame, city: str, test_year: int,
                      horizons: Iterable[int] = (1, 2, 3, 4, 5, 6, 7),
                      min_history: int = STATION_MIN_HISTORY_DAYS) -> pd.DataFrame:
    """backtest(), fitted and scored per station, then averaged across stations.

    `frame` is a station-level daily table (city, station, d, v) -- either
    load_station_daily() for PM2.5 or load_station_daily_aqi() for composite
    AQI.

    Each station gets its OWN climatology and its own alpha, because both are
    served per station. The reported MAE is the unweighted mean of the stations'
    MAEs: every station counts once, so a monitor that reports twice as often
    does not get twice the say in how good the forecast is.

    `alpha` comes back as the MEDIAN across stations, since there is no longer
    one of them. `n` is the total station-days behind the figure and
    `n_stations` how many stations contributed -- both needed to read the row
    honestly.
    """
    per_station: List[pd.DataFrame] = []
    for station, s in _station_series(frame, city).items():
        if s[s.index.year < test_year].notna().sum() < min_history:
            continue
        got = backtest(s, test_year, horizons)
        if got.empty:
            continue
        got = got[got.n >= STATION_MIN_TEST_DAYS]
        if got.empty:
            continue
        per_station.append(got.assign(station=station))

    if not per_station:
        return pd.DataFrame()

    allrows = pd.concat(per_station, ignore_index=True)
    agg = (allrows.groupby(["test_year", "horizon", "model", "subset"], as_index=False)
                  .agg(mae=("mae", "mean"),
                       rmse=("rmse", "mean"),
                       bias=("bias", "mean"),
                       alpha=("alpha", "median"),
                       n=("n", "sum"),
                       n_stations=("station", "nunique")))
    agg["city"] = city
    # Same column order as backtest(), so callers cannot tell them apart.
    return agg[["city", "test_year", "horizon", "model", "subset", "n",
                "mae", "rmse", "bias", "alpha", "n_stations"]]


def predictions_for_stations(frame: pd.DataFrame, city: str, test_year: int,
                             h: int,
                             min_history: int = STATION_MIN_HISTORY_DAYS) -> pd.DataFrame:
    """predictions_for(), per station, stacked long with a `station` column.

    Use for anything scored per station and then averaged -- band agreement,
    for instance. Collapsing this to a city mean before scoring would reinstate
    exactly the cancellation these functions exist to avoid.
    """
    frames: List[pd.DataFrame] = []
    for station, s in _station_series(frame, city).items():
        if s[s.index.year < test_year].notna().sum() < min_history:
            continue
        if s[s.index.year == test_year].notna().sum() < STATION_MIN_TEST_DAYS:
            continue
        got = predictions_for(s, test_year, h)
        frames.append(got.assign(station=station, city=city))
    return pd.concat(frames) if frames else pd.DataFrame()


def per_station_table(frame: pd.DataFrame, city: str, fn, *args,
                      min_history: int = STATION_MIN_HISTORY_DAYS,
                      **kwargs) -> pd.DataFrame:
    """Run any series-level analysis per station and average across stations.

    Generic because backtest_stale_input, backtest_anomaly_window and
    residual_bands all take a daily Series and return a tidy frame with a
    `city` column, some key columns and some numbers. Rather than three
    near-identical wrappers, this runs `fn` on each station's own series and
    averages the numeric columns within each combination of the key columns.

    Key columns are inferred: everything non-numeric, plus any integer column
    that looks like a parameter rather than a measurement (horizon, window,
    lag). `n` is summed, since it counts observations rather than measuring
    one, and `n_stations` is added so a row can be read honestly.
    """
    # Parameters of the experiment, not measurements of it. Averaging one of
    # these silently collapses rows that should stay separate -- `forecast_for`
    # did exactly that, folding three horizons into a single row reading 2.0.
    KEYLIKE = {"horizon", "want", "forecast_for", "effective_horizon",
               "data_lag", "lag", "window_days", "quantile",
               "data_age_days", "horizon_days", "test_year"}
    per: List[pd.DataFrame] = []
    for station, s in _station_series(frame, city).items():
        if s[s.index.year < kwargs.get("test_year", args[0] if args else 0)].notna().sum() < min_history:
            continue
        try:
            got = fn(s, *args, **kwargs)
        except Exception:
            continue
        if got is None or len(got) == 0:
            continue
        per.append(got.assign(station=station))

    if not per:
        return pd.DataFrame()

    allrows = pd.concat(per, ignore_index=True)
    keys = [c for c in allrows.columns
            if c in KEYLIKE or (allrows[c].dtype == object and c not in ("city", "station"))]
    numeric = [c for c in allrows.columns
               if c not in keys + ["city", "station"] and pd.api.types.is_numeric_dtype(allrows[c])]

    how = {c: (c, "sum") if c == "n" else (c, "mean") for c in numeric}
    agg = allrows.groupby(keys, as_index=False, dropna=False).agg(
        **how, n_stations=("station", "nunique"))
    agg["city"] = city
    return agg
