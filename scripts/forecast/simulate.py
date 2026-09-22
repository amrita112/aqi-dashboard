"""
Replay the nightly forecast over a past window, using only what the database
actually held at each run time, and score it against what later turned out to
be true.

WRITES NOTHING TO SUPABASE. Reads come from the local parquet cache built by
scripts/analysis/fetch_simulation_data.py; every output stays on disk.

The question this answers: on the night of D, with whatever data had landed by
then, what would the app have told a user about D+1 -- and how wrong was it,
hour by hour?

Two availability branches, run side by side:

  'honest'   a reading counts as available only if readings.created_at is at or
             before the cutoff. This is literally what was in the database.
             Between 1 and 20 Sep it is bleak, because the live-API ingest was
             dead (the 8h fetch window, fixed 17 Sep in a57b78d) and everything
             arrived via the T-7 S3 backfill, roughly 170 hours late.

  'fixed48'  a reading counts as available once 48 hours have passed since it
             was measured -- today's ingest, applied retrospectively. Not a
             record of anything that happened; a counterfactual for what the
             same forecast code would have managed with the window it has now.

The gap between the two is the value of the 48h window.

Everything is on UTC day boundaries, matching rollup_daily.py. A "day" is
therefore not an Indian calendar day; it is shifted 5h30m. This is the
production convention and the simulation follows it rather than inventing a
second one.
"""

from __future__ import annotations

import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

REPO = Path(__file__).resolve().parents[2]
CACHE = REPO / "data" / "simulation-cache"
sys.path.insert(0, str(REPO))

from scripts.ingest.lib.aqi_utils import compute_subindex  # noqa: E402

# The nightly forecast workflow runs at 05:30 UTC (forecast-nightly.yml), half
# an hour after the rollup. That instant, not midnight, is what a station's
# data had to beat to be usable.
RUN_HOUR_UTC = 5
RUN_MINUTE_UTC = 30

# Mirrors nightly_forecast.py. Repeated rather than imported because that
# module reaches for a live Supabase client at import time.
FORECAST_HORIZONS = (1, 2, 3)
MAX_OBSERVATION_AGE_DAYS = 14
MIN_HISTORY_DAYS = 365
MEASURED_POLLUTANTS = ("pm25", "pm10", "no2", "so2")

BRANCHES = ("honest", "fixed48")
FIXED_LAG_HOURS = 48


# ─────────────────────────────────────────────────────────────────────────────
# Loading
# ─────────────────────────────────────────────────────────────────────────────

def load_cache(cache_dir: Path = CACHE) -> Dict[str, pd.DataFrame]:
    """Read the parquet cache. Fails loudly rather than silently re-fetching."""
    names = ["monitors", "readings", "measurements",
             "forecast_params", "diurnal_shape", "forecast_modes"]
    missing = [n for n in names if not (cache_dir / f"{n}.parquet").exists()]
    if missing:
        raise FileNotFoundError(
            f"Cache incomplete at {cache_dir} (missing: {', '.join(missing)}). "
            "Run: python3 -m scripts.analysis.fetch_simulation_data")
    return {n: pd.read_parquet(cache_dir / f"{n}.parquet") for n in names}


def build_observation_frame(data: Dict[str, pd.DataFrame]) -> pd.DataFrame:
    """One row per measurement, carrying the station, city and both clocks.

    This is the single table everything else is derived from: filter it by
    availability to get what a given night knew, or take it whole to get truth.
    """
    readings = data["readings"].copy()
    readings["recorded_at"] = pd.to_datetime(readings["recorded_at"], utc=True)
    readings["created_at"] = pd.to_datetime(readings["created_at"], utc=True)

    monitors = data["monitors"][["id", "city_label", "name"]].rename(
        columns={"id": "monitor_id", "name": "station"})

    obs = (data["measurements"]
           .merge(readings, left_on="reading_id", right_on="id", how="inner")
           .merge(monitors, on="monitor_id", how="inner"))

    obs = obs[obs["pollutant"].isin(MEASURED_POLLUTANTS)].copy()
    # A negative concentration is a sensor fault, not a low reading, and
    # compute_subindex refuses them outright.
    obs = obs[obs["value"] >= 0].copy()

    obs["date"] = obs["recorded_at"].dt.floor("D").dt.tz_localize(None)
    obs["hour"] = obs["recorded_at"].dt.hour
    return obs[["monitor_id", "station", "city_label", "pollutant", "value",
                "recorded_at", "created_at", "date", "hour"]]


# ─────────────────────────────────────────────────────────────────────────────
# Availability: what did this night actually have?
# ─────────────────────────────────────────────────────────────────────────────

def cutoff_for(run_date: date) -> pd.Timestamp:
    """The instant the nightly job would have queried the database."""
    return pd.Timestamp(datetime(run_date.year, run_date.month, run_date.day,
                                 RUN_HOUR_UTC, RUN_MINUTE_UTC, tzinfo=timezone.utc))


def available_at(obs: pd.DataFrame, cutoff: pd.Timestamp, branch: str) -> pd.DataFrame:
    """Rows a forecast run at `cutoff` could have seen, under one branch."""
    if branch == "honest":
        return obs[obs["created_at"] <= cutoff]
    if branch == "fixed48":
        return obs[obs["recorded_at"] <= cutoff - pd.Timedelta(hours=FIXED_LAG_HOURS)]
    raise ValueError(f"unknown branch {branch!r}")


def daily_means(rows: pd.DataFrame) -> pd.DataFrame:
    """Per (monitor, pollutant, UTC day) mean — what readings_daily would hold.

    readings_daily itself carries no ingest timestamp (there is no created_at on
    that table), so the simulation cannot ask it what it looked like on a past
    night. Rebuilding the rollup from raw readings is the only way to get an
    as-of view, and is why this simulation depends on raw retention.
    """
    if rows.empty:
        return pd.DataFrame(columns=["monitor_id", "pollutant", "date", "mean"])
    return (rows.groupby(["monitor_id", "pollutant", "date"], observed=True)["value"]
                .mean().reset_index().rename(columns={"value": "mean"}))


def daily_aqi(daily: pd.DataFrame) -> pd.DataFrame:
    """Composite AQI per (monitor, day): max sub-index across that day's pollutants.

    Grouped by day so the max is taken over pollutants measured on the SAME
    day. Mixing days would invent an AQI that never occurred — the same care
    nightly_forecast.latest_observations takes.
    """
    if daily.empty:
        return pd.DataFrame(columns=["monitor_id", "pollutant", "date", "mean"])
    d = daily.copy()
    d["sub"] = [compute_subindex(p, v) for p, v in zip(d["pollutant"], d["mean"])]
    out = (d.groupby(["monitor_id", "date"], observed=True)["sub"]
             .max().reset_index().rename(columns={"sub": "mean"}))
    out["pollutant"] = "aqi"
    return out[["monitor_id", "pollutant", "date", "mean"]]


def latest_observation(daily: pd.DataFrame, run_date: date
                       ) -> Dict[Tuple[str, str], Tuple[date, float]]:
    """(monitor, pollutant) -> most recent usable (day, value) as of run_date."""
    if daily.empty:
        return {}
    # Strictly BEFORE run_date: the 05:30 UTC job runs half an hour after the
    # rollup, which compresses completed days. Today's partial day has no
    # readings_daily row yet, so treating it as observable would give the
    # simulation a freshness production never had.
    floor = pd.Timestamp(run_date) - pd.Timedelta(days=MAX_OBSERVATION_AGE_DAYS)
    recent = daily[(daily["date"] >= floor) & (daily["date"] < pd.Timestamp(run_date))]
    if recent.empty:
        return {}
    idx = recent.groupby(["monitor_id", "pollutant"], observed=True)["date"].idxmax()
    picked = recent.loc[idx]
    return {(r.monitor_id, r.pollutant): (r.date.date(), float(r.mean))
            for r in picked.itertuples()}


# ─────────────────────────────────────────────────────────────────────────────
# The forecast itself
# ─────────────────────────────────────────────────────────────────────────────

def _nearest_mode(modes_idx: Dict, city: str, pollutant: str,
                  age: int, horizon: int) -> Optional[dict]:
    """Mode row for this data age, rounding UP to the next fitted age.

    Claiming the skill of a fresher reading than we have would be the wrong
    way to be wrong. Same rule as nightly_forecast.nearest_mode.
    """
    exact = modes_idx.get((city, pollutant, age, horizon))
    if exact:
        return exact
    older = sorted(a for (c, p, a, h) in modes_idx
                   if c == city and p == pollutant and h == horizon and a >= age)
    if older:
        return modes_idx[(city, pollutant, older[0], horizon)]
    worst = sorted((a for (c, p, a, h) in modes_idx
                    if c == city and p == pollutant and h == horizon), reverse=True)
    return modes_idx[(city, pollutant, worst[0], horizon)] if worst else None


def forecast_one(params_row: dict, city: str, pollutant: str,
                 observation: Optional[Tuple[date, float]],
                 modes_idx: Dict, run_date: date, horizon: int = 1
                 ) -> Optional[dict]:
    """Day+`horizon` daily forecast for one station-pollutant.

    Faithful to nightly_forecast.build_station_rows: anomaly against
    climatology, carried forward by the alpha for the EFFECTIVE horizon
    (data age + horizon), and downgraded to the seasonal normal whenever the
    mode table says the measured skill at that age is no better than average.
    """
    clim = params_row["climatology"]
    target = run_date + timedelta(days=horizon)

    def clim_for(d: date) -> Optional[float]:
        doy = d.timetuple().tm_yday
        v = clim[doy] if doy < len(clim) else 0.0
        return float(v) if v else None

    anomaly, based_on, age = 0.0, None, None
    if observation is not None:
        obs_date, obs_value = observation
        age = (run_date - obs_date).days
        base_obs = clim_for(obs_date)
        if base_obs is not None and age <= MAX_OBSERVATION_AGE_DAYS:
            anomaly, based_on = obs_value - base_obs, obs_date
        else:
            age = None

    degraded = (age is None) or (int(params_row["history_days"]) < MIN_HISTORY_DAYS)

    base = clim_for(target)
    if base is None:
        return None

    if degraded or horizon not in FORECAST_HORIZONS:
        value, mode, model = base, "seasonal_normal", "climatology"
    else:
        effective = min(age + horizon, 3)
        alpha = float(params_row[f"alpha_h{effective}"])
        m = _nearest_mode(modes_idx, city, pollutant, age, horizon)
        mode = m["mode"] if m else "outlook"
        if mode == "seasonal_normal":
            # Serve the seasonal average when that is what the label says.
            # Carrying the anomaly forward under a "seasonal_normal" label
            # would put a number on screen contradicting its own label.
            value, model = base, "climatology"
        else:
            value = max(base + alpha * anomaly, 0.0)
            model = params_row["model"]

    return {"target_date": target, "value": float(value), "mode": mode,
            "model": model, "data_age_days": age,
            "based_on_date": based_on, "climatology": base}


def hourly_from_daily(daily_value: float, shape_idx: Dict,
                      city: str, pollutant: str, target: date) -> np.ndarray:
    """Spread a daily forecast across 24 hours using the diurnal ratio table.

    forecast(day, hour) = daily_forecast(day) x shape(city, month, hour).
    The shape is a ratio, so it scales with the level: a shape learned in a
    clean month still applies in a dirty one. Missing city-months fall back to
    a flat day rather than dropping the station.
    """
    ratios = shape_idx.get((city, pollutant, target.month))
    if ratios is None:
        return np.full(24, daily_value, dtype=float)
    return daily_value * ratios


# ─────────────────────────────────────────────────────────────────────────────
# Truth
# ─────────────────────────────────────────────────────────────────────────────

def hourly_actuals(obs: pd.DataFrame) -> pd.DataFrame:
    """Per (monitor, pollutant, day, hour) mean, plus composite AQI per hour.

    Uses the COMPLETE dataset regardless of created_at: this is what turned out
    to be true, which is knowable now even though it was not knowable then.
    """
    base = (obs.groupby(["monitor_id", "city_label", "pollutant", "date", "hour"],
                        observed=True)["value"].mean().reset_index()
               .rename(columns={"value": "actual"}))

    aqi = base.copy()
    aqi["sub"] = [compute_subindex(p, v) for p, v in zip(aqi["pollutant"], aqi["actual"])]
    aqi = (aqi.groupby(["monitor_id", "city_label", "date", "hour"], observed=True)["sub"]
              .max().reset_index().rename(columns={"sub": "actual"}))
    aqi["pollutant"] = "aqi"

    return pd.concat([base, aqi[base.columns]], ignore_index=True)


# ─────────────────────────────────────────────────────────────────────────────
# The run loop
# ─────────────────────────────────────────────────────────────────────────────

def index_shape(diurnal: pd.DataFrame) -> Dict[Tuple[str, str, int], np.ndarray]:
    """(city, pollutant, month) -> 24 ratios, hour 0..23."""
    out: Dict[Tuple[str, str, int], np.ndarray] = {}
    for (city, pol, month), grp in diurnal.groupby(["city", "pollutant", "month"]):
        arr = np.full(24, np.nan)
        for h, r in zip(grp["hour"], grp["ratio"]):
            arr[int(h)] = float(r)
        # A city-month missing an hour is a thin cell, not a zero. Filling with
        # 1.0 keeps that hour at the daily mean instead of predicting nothing.
        arr = np.where(np.isnan(arr), 1.0, arr)
        out[(city, pol, int(month))] = arr
    return out


def index_modes(modes: pd.DataFrame) -> Dict[Tuple[str, str, int, int], dict]:
    return {(r["city"], r["pollutant"], int(r["data_age_days"]), int(r["horizon_days"])): r
            for r in modes.to_dict("records")}


def run_simulation(obs: pd.DataFrame, data: Dict[str, pd.DataFrame],
                   run_dates: List[date], pollutants: Tuple[str, ...] = ("pm25", "aqi"),
                   branches: Tuple[str, ...] = BRANCHES,
                   horizon: int = 1, verbose: bool = True) -> pd.DataFrame:
    """Replay every night in `run_dates`, both branches, and return per-station-hour rows.

    Returns one row per (branch, run_date, monitor, pollutant, hour) carrying
    the prediction, the later-known truth, and the error.
    """
    params_idx = {(r["monitor_id"], r["pollutant"]): r
                  for r in data["forecast_params"].to_dict("records")}
    modes_idx = index_modes(data["forecast_modes"])
    shape_idx = index_shape(data["diurnal_shape"])
    city_of = dict(zip(data["monitors"]["id"], data["monitors"]["city_label"]))

    actuals = hourly_actuals(obs)
    actual_idx = {(r.monitor_id, r.pollutant, r.date.date(), int(r.hour)): float(r.actual)
                  for r in actuals.itertuples()}

    records: List[dict] = []
    for branch in branches:
        for run_date in run_dates:
            cutoff = cutoff_for(run_date)
            got = available_at(obs, cutoff, branch)
            daily = daily_means(got)
            daily = pd.concat([daily, daily_aqi(daily)], ignore_index=True) \
                if not daily.empty else daily
            latest = latest_observation(daily, run_date)

            for (monitor_id, pollutant), params_row in params_idx.items():
                if pollutant not in pollutants:
                    continue
                city = city_of.get(monitor_id)
                if city is None:
                    continue
                fc = forecast_one(params_row, city, pollutant,
                                  latest.get((monitor_id, pollutant)),
                                  modes_idx, run_date, horizon)
                if fc is None:
                    continue
                target = fc["target_date"]
                hourly = hourly_from_daily(fc["value"], shape_idx, city, pollutant, target)
                for hour in range(24):
                    actual = actual_idx.get((monitor_id, pollutant, target, hour))
                    if actual is None:
                        continue  # station silent that hour; nothing to score against
                    records.append({
                        "branch": branch, "run_date": run_date, "target_date": target,
                        "monitor_id": monitor_id, "city": city, "pollutant": pollutant,
                        "hour": hour, "predicted": float(hourly[hour]),
                        "actual": actual, "error": float(hourly[hour]) - actual,
                        "mode": fc["mode"], "data_age_days": fc["data_age_days"],
                        "climatology": fc["climatology"],
                    })
            if verbose:
                n = sum(1 for r in records if r["branch"] == branch and r["run_date"] == run_date)
                ages = [r["data_age_days"] for r in records
                        if r["branch"] == branch and r["run_date"] == run_date
                        and r["data_age_days"] is not None]
                med = int(np.median(ages)) if ages else None
                print(f"  {branch:8s} {run_date}  {n:6,d} station-hours  "
                      f"median data age: {med if med is not None else '--'} d", flush=True)

    return pd.DataFrame(records)


def score_by_city_hour(sim: pd.DataFrame) -> pd.DataFrame:
    """Average error over all stations in a city, per branch/pollutant/day/hour.

    MAE is the headline (it is in the units the user sees). Bias is kept
    alongside because a forecast that is 20 too high half the time and 20 too
    low the other half has the same MAE as one that is always 20 high, and
    those are different problems.
    """
    g = sim.groupby(["branch", "pollutant", "city", "target_date", "hour"], observed=True)
    out = g.agg(
        mae=("error", lambda s: float(np.mean(np.abs(s)))),
        bias=("error", "mean"),
        rmse=("error", lambda s: float(np.sqrt(np.mean(np.square(s))))),
        predicted=("predicted", "mean"),
        actual=("actual", "mean"),
        n_stations=("monitor_id", "nunique"),
    ).reset_index()
    return out.sort_values(["branch", "pollutant", "city", "target_date", "hour"])


def climatology_baseline(sim: pd.DataFrame) -> pd.DataFrame:
    """Skill reference: what the error would have been serving bare climatology.

    The regression test scores the forecast RELATIVE to this rather than against
    an absolute error threshold, because absolute error scales with
    concentration -- a fixed MAE bound would pass all autumn and fail every day
    from November for reasons that have nothing to do with the code.
    """
    base = sim.copy()
    base["clim_error"] = base["climatology"] - base["actual"]
    out = (base.groupby(["branch", "pollutant", "city"], observed=True)
               .agg(climatology_mae=("clim_error", lambda s: float(np.mean(np.abs(s)))),
                    forecast_mae=("error", lambda s: float(np.mean(np.abs(s)))))
               .reset_index())
    # Positive = the forecast beats the seasonal average. This is the scale-free
    # quantity the regression test gates on.
    out["skill_vs_climatology"] = 1.0 - out["forecast_mae"] / out["climatology_mae"]
    return out
