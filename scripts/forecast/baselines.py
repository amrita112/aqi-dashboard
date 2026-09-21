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
from typing import Any, Dict, Iterable, List, Optional, Tuple

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

PROJECT_ROOT = Path(__file__).resolve().parents[2]
XKDR_GLOB = str(PROJECT_ROOT / "data" / "XKDR_data" / "data" / "v1"
                / "measurements" / "*" / "*" / "data.parquet")

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
    df = con.sql(f"""
        WITH station_day AS (
            SELECT {_city_sql_case()} AS city_name, station_id,
                   CAST(collected_at AS DATE) AS d, avg(value) AS v
            FROM m
            WHERE parameter_name = 'PM2.5'
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


# ─── Hourly series and the diurnal shape ─────────────────────────────────────

CITY_HOURLY_CACHE = PROJECT_ROOT / "data" / "xkdr_city_hourly.parquet"


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


def complete_days(g: pd.DataFrame, min_hours: int = 20) -> pd.DataFrame:
    """Keep only days with enough hours for a daily mean to mean anything."""
    return g[g.groupby("d")["pm25"].transform("size") >= min_hours]


def diurnal_shape(train: pd.DataFrame) -> pd.Series:
    """Mean ratio of hourly value to that day's mean, per (month, hour).

    A RATIO rather than an absolute profile, so the shape scales with the
    level: one learned in a clean month still applies in a dirty one. Indexed
    by (month, hour); multiply a daily forecast by it to get an hourly one.
    """
    day_mean = train.groupby("d")["pm25"].transform("mean")
    ok = day_mean > 1                      # avoid dividing by ~0 on clean days
    t = train[ok].assign(ratio=train.loc[ok, "pm25"] / day_mean[ok])
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

STATION_DAILY_CACHE = PROJECT_ROOT / "data" / "xkdr_station_daily.parquet"


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


def backtest_hierarchical(station_daily: pd.DataFrame, test_year: int,
                          min_station_days: int = 500,
                          min_overlap_days: int = 200) -> pd.DataFrame:
    """Test `city_forecast x station_ratio(month)` against a standalone model.

    The idea, by analogy with the diurnal shape: forecast the robust aggregate,
    then distribute it with a cheap per-station ratio. It sounds right and it
    does not work -- kept here so the rejection stays reproducible rather than
    becoming folklore, and so nobody rebuilds it.
    """
    rows: List[Dict[str, Any]] = []

    for city, g in station_daily.groupby("city"):
        city_s = _as_series(g, city)
        city_train = city_s[city_s.index.year < test_year].dropna()
        if len(city_train) < 300:
            continue
        clim = climatology(city_train)
        alpha = fit_alpha(city_train, clim, 1)

        counts = g.groupby("station").size()
        for st in [s for s in counts.index if counts[s] >= min_station_days]:
            st_s = _as_series(g[g.station == st], f"{city} :: {st}")
            standalone = evaluate_series(st_s, test_year)
            if standalone is None:
                continue
            test = st_s[st_s.index.year == test_year].dropna()
            test = test[test.index.month.isin(SEASON_MONTHS)]

            joined = pd.DataFrame({"st": st_s, "city": city_s}).dropna()
            joined = joined[(joined.index.year < test_year) & (joined["city"] > 1)]
            if len(joined) < min_overlap_days:
                continue
            ratio = (joined["st"] / joined["city"]).groupby(joined.index.month).mean()

            idx = test.index
            prev = _lagged(city_s, idx, 1)
            cl_now = pd.Series(clim.reindex(idx.dayofyear).values, index=idx)
            cl_prev = pd.Series(
                clim.reindex((idx - pd.Timedelta(days=1)).dayofyear).values, index=idx)
            pred = (cl_now + alpha * (prev - cl_prev)) * pd.Series(
                ratio.reindex(idx.month).values, index=idx)

            mask = pred.notna() & test.notna()
            if mask.sum() < 20:
                continue
            rows.append({"city": city, "station": st, "n": int(mask.sum()),
                         "mae_hierarchical": float(np.abs(pred[mask] - test[mask]).mean()),
                         "mae_standalone": standalone["mae_blend"]})
    df = pd.DataFrame(rows)
    if not df.empty:
        df["pct_improvement"] = (100 * (df.mae_standalone - df.mae_hierarchical)
                                 / df.mae_standalone)
        df["hierarchical_better"] = df.mae_hierarchical < df.mae_standalone
    return df


# ─── Serving-architecture checks ─────────────────────────────────────────────


def backtest_precompute_equivalence(station_daily: pd.DataFrame, test_year: int,
                                    k: int = 3, trials: int = 12,
                                    min_station_days: int = 500,
                                    seed: int = 0) -> pd.DataFrame:
    """Can we precompute per station and average, instead of forecasting the mix?

    This is the question the serving design rests on. The backtest validated
    forecasting the k-station AGGREGATE, but a user's location is continuous --
    we cannot precompute a forecast for every point someone might stand on. We
    can precompute per station, then average the k nearest at request time.

    Those are only the same thing if the model is linear in its inputs AND the
    weight alpha is shared. It is linear, so the test is whether a shared
    per-city alpha closes the gap. Reported both ways.
    """
    rng = np.random.default_rng(seed)
    rows: List[Dict[str, Any]] = []

    for city, g in station_daily.groupby("city"):
        counts = g.groupby("station").size()
        stations = [s for s in counts.index if counts[s] >= min_station_days]
        if len(stations) < k:
            continue
        city_s = g.groupby("d")["v"].mean().asfreq("D")
        city_train = city_s[city_s.index.year < test_year].dropna()
        if len(city_train) < 300:
            continue
        city_alpha = fit_alpha(city_train, climatology(city_train), 1)

        for _ in range(trials):
            pick = list(rng.choice(stations, size=k, replace=False))
            agg = g[g.station.isin(pick)].groupby("d")["v"].mean().asfreq("D")
            agg_train = agg[agg.index.year < test_year].dropna()
            if len(agg_train) < 300:
                continue
            test = agg[agg.index.year == test_year].dropna()
            test = test[test.index.month.isin(SEASON_MONTHS)]
            if len(test) < 40:
                continue
            idx = test.index

            def forecast(series: pd.Series, clim: pd.Series, alpha: float) -> pd.Series:
                prev = _lagged(series, idx, 1)
                cl_now = pd.Series(clim.reindex(idx.dayofyear).values, index=idx)
                cl_prev = pd.Series(
                    clim.reindex((idx - pd.Timedelta(days=1)).dayofyear).values, index=idx)
                return cl_now + alpha * (prev - cl_prev)

            aggregate_fc = forecast(agg, climatology(agg_train), city_alpha)

            shared, own = [], []
            for st in pick:
                ss = g[g.station == st].groupby("d")["v"].mean().asfreq("D")
                st_train = ss[ss.index.year < test_year].dropna()
                if len(st_train) < 300:
                    continue
                st_clim = climatology(st_train)
                shared.append(forecast(ss, st_clim, city_alpha))
                own.append(forecast(ss, st_clim, fit_alpha(st_train, st_clim, 1)))
            if len(shared) < k:
                continue

            for label, parts in (("shared_alpha", shared), ("per_station_alpha", own)):
                avg = pd.concat(parts, axis=1).mean(axis=1)
                m = aggregate_fc.notna() & avg.notna()
                if m.sum() < 20:
                    continue
                rows.append({
                    "city": city, "k": k, "alpha_scheme": label,
                    "mean_abs_diff": float(np.abs(aggregate_fc[m] - avg[m]).mean()),
                    "forecast_level": float(test.mean()), "n": int(m.sum()),
                })
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
