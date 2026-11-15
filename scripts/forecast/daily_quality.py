"""
Which station-days are complete enough to forecast from, fit on, or score against.

ONE rule, used everywhere a daily value enters the forecast:

  * nightly_forecast.latest_observations  -- the day the forecast starts from
  * nightly_forecast.load_scored_history  -- what the bias correction scores against
  * baselines.load_history_from_db        -- the history the monthly refit fits on
  * notebooks/forecast_verification.ipynb -- the checks you read

Before Nov 2026 none of these checked completeness. A day with one 15-minute
reading counted as a full day, and because OpenAQ publishes in bursts, the
newest day -- the one every forecast starts from -- was the day most likely to
be only partly published (audit §7.3).

THE RULE

  1. A pollutant's day is complete when it has at least 16 hours' worth of
     readings. This is CPCB's own rule for a 24-hour average.

     "Hours' worth" depends on how often the station reports. XKDR history is
     hourly (24 readings make a full day); OpenAQ is mostly every 15 minutes
     (96), with a few hourly stations. The cadence is not stored anywhere, so it
     is inferred per station and pollutant from its typical day: the 90th
     percentile of its daily counts. Above 30 means a 15-minute station.

  2. Values outside 0-2000 are dropped as instrument faults. Same bounds the
     XKDR loaders have always used.

  3. A day's composite AQI needs at least 3 complete pollutants, one of which
     is PM2.5 or PM10. This is CPCB's minimum for NAQI. Without it, a day where
     only NO2 had been published became an AQI of 44 on a day that was really
     347 (audit §4.2).

Everything here takes and returns pandas DataFrames with the columns
readings_daily uses: monitor_id, pollutant, date, mean, count (and source,
when present).
"""

from __future__ import annotations

from typing import Iterable

import pandas as pd

# CPCB: a 24-hour average needs at least 16 hours of data.
MIN_HOURS_FOR_COMPLETE_DAY = 16

# Readings per full day at each cadence.
READINGS_PER_DAY_HOURLY = 24
READINGS_PER_DAY_15MIN = 96

# A station whose typical (90th percentile) day has more readings than this
# reports every 15 minutes. Hourly stations top out at 24; 15-minute stations
# sit around 85-96. 30 leaves room for an hourly station that occasionally
# double-reports.
CADENCE_SPLIT = 30

# Plausible daily means, in the units readings_daily stores (µg/m³).
VALID_MIN, VALID_MAX = 0.0, 2000.0

# CPCB's NAQI minimum: this many pollutants, including at least one PM.
MIN_POLLUTANTS_FOR_AQI = 3
PM_POLLUTANTS = ("pm25", "pm10")


def _cadence_keys(df: pd.DataFrame) -> list:
    """Group by source too when it is known: the same monitor can have hourly
    XKDR history and 15-minute OpenAQ days."""
    keys = ["monitor_id", "pollutant"]
    if "source" in df.columns:
        keys.append("source")
    return keys


def complete_mask(df: pd.DataFrame) -> pd.Series:
    """True for each row that is a complete, plausible day (rules 1 and 2)."""
    if df.empty:
        return pd.Series(dtype=bool, index=df.index)
    count = pd.to_numeric(df["count"], errors="coerce")
    mean = pd.to_numeric(df["mean"], errors="coerce")

    # The station's typical day, which tells us its cadence.
    typical = count.groupby([df[k] for k in _cadence_keys(df)]).transform(
        lambda s: s.quantile(0.9))
    per_day = typical.gt(CADENCE_SPLIT).map(
        {True: READINGS_PER_DAY_15MIN, False: READINGS_PER_DAY_HOURLY})
    needed = per_day * MIN_HOURS_FOR_COMPLETE_DAY / 24

    return count.ge(needed) & mean.between(VALID_MIN, VALID_MAX)


def complete_days(df: pd.DataFrame) -> pd.DataFrame:
    """Only the rows that pass complete_mask."""
    return df[complete_mask(df)]


def station_day_aqi(complete: pd.DataFrame) -> pd.DataFrame:
    """Composite AQI per (monitor_id, date), from rows that are ALREADY complete.

    Each pollutant's daily mean becomes its sub-index; the AQI is the largest.
    A day without 3 pollutants including a PM gets no AQI at all (rule 3).

    Returns monitor_id, date, aqi, dominant (the pollutant that set the max),
    plus any extra key columns (e.g. city) that are constant per monitor.
    """
    from scripts.ingest.lib.aqi_utils import compute_subindex

    cols = ["monitor_id", "date", "aqi", "dominant"]
    if complete.empty:
        return pd.DataFrame(columns=cols)

    sub = complete.copy()
    sub["si"] = [compute_subindex(p, float(v))
                 for p, v in zip(sub["pollutant"], sub["mean"])]
    sub = sub.dropna(subset=["si"])

    keys = [sub["monitor_id"], sub["date"]]
    n_pollutants = sub["pollutant"].groupby(keys).transform("nunique")
    # Vectorised "any PM on this day" -- a Python lambda per station-day is
    # far too slow over 15 years of history.
    has_pm = sub["pollutant"].isin(PM_POLLUTANTS).groupby(keys).transform("any")
    sub = sub[(n_pollutants >= MIN_POLLUTANTS_FOR_AQI) & has_pm]
    if sub.empty:
        return pd.DataFrame(columns=cols)

    top = sub.loc[sub.groupby(["monitor_id", "date"])["si"].idxmax()]
    out = top.rename(columns={"si": "aqi", "pollutant": "dominant"})
    extra = [c for c in ("city",) if c in out.columns]
    return out[cols + extra].reset_index(drop=True)


def station_day_values(df: pd.DataFrame, pollutant: str) -> pd.DataFrame:
    """The daily value the forecast uses, per (monitor_id, date).

    `df` is raw readings_daily-shaped rows (any completeness). Returns columns
    monitor_id, date, value -- only for days that pass the rules above.
    For 'aqi' the value is the composite AQI; otherwise the pollutant's mean.
    """
    complete = complete_days(df)
    if pollutant == "aqi":
        aqi = station_day_aqi(complete)
        return aqi.rename(columns={"aqi": "value"})[["monitor_id", "date", "value"]]
    rows = complete[complete["pollutant"] == pollutant]
    return (rows.rename(columns={"mean": "value"})[["monitor_id", "date", "value"]]
                .reset_index(drop=True))


def rows_to_frame(rows: Iterable[dict]) -> pd.DataFrame:
    """Supabase rows (a list of dicts) -> a DataFrame with the expected columns."""
    df = pd.DataFrame(list(rows))
    for col in ("monitor_id", "pollutant", "date", "mean", "count"):
        if col not in df.columns:
            df[col] = pd.Series(dtype=object)
    return df
