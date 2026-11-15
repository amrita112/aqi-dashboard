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

THE RULE -- its numbers live in lib/daily-quality-config.json, which the app's
TypeScript (lib/api/daily-quality.ts) reads too, so both apply one rule.

  1. A pollutant's day is complete when it has at least 16 hours' worth of
     readings. This is CPCB's own rule for a 24-hour average.

     "Hours' worth" depends on how often the station reports. XKDR history is
     hourly (24 readings make a full day); OpenAQ is mostly every 15 minutes
     (96), with a few hourly stations. The cadence is not stored anywhere, so it
     is inferred per station and pollutant from its typical day: the 90th
     percentile of its daily counts. Above 30 means a 15-minute station.

  2. Values outside 0-2000 are dropped as instrument faults. Same bounds the
     XKDR loaders have always used.

  3. A day's composite AQI needs a minimum set of complete pollutants. Two
     rules are available (DEFAULT_AQI_RULE picks one):

       both_pm  (default) PM2.5 AND PM10. NO2/SO2 join the max when present.
       cpcb     CPCB's NAQI minimum: 3 pollutants, one of them a PM.

     Without any rule, a day where only NO2 had been published became an AQI
     of 44 on a day that was really 347 (audit §4.2). Why both_pm is the
     default for our 4 pollutants: see the config file.

Everything here takes and returns pandas DataFrames with the columns
readings_daily uses: monitor_id, pollutant, date, mean, count (and source,
when present).
"""

from __future__ import annotations

from typing import Iterable

import pandas as pd

import json
from pathlib import Path

CONFIG_PATH = Path(__file__).resolve().parents[2] / "lib" / "daily-quality-config.json"
_CFG = json.loads(CONFIG_PATH.read_text())

MIN_HOURS_FOR_COMPLETE_DAY = _CFG["min_hours_for_complete_day"]
READINGS_PER_DAY_HOURLY = _CFG["readings_per_day_hourly"]
READINGS_PER_DAY_15MIN = _CFG["readings_per_day_15min"]
CADENCE_SPLIT = _CFG["cadence_split"]
CADENCE_QUANTILE = _CFG["cadence_quantile"]
VALID_MIN, VALID_MAX = float(_CFG["valid_min"]), float(_CFG["valid_max"])

# The AQI rule lives in scripts/ingest/lib/aqi_rule.py, which the ingests use
# for each timestamp's AQI; the daily AQI here applies the same rule.
from scripts.ingest.lib.aqi_rule import AQI_RULES, DEFAULT_AQI_RULE  # noqa: E402
PM_POLLUTANTS = ("pm25", "pm10")


def _cadence_keys(df: pd.DataFrame) -> list:
    """Group by source too when it is known: the same monitor can have hourly
    XKDR history and 15-minute OpenAQ days."""
    keys = ["monitor_id", "pollutant"]
    if "source" in df.columns:
        keys.append("source")
    return keys


def computed_complete_mask(df: pd.DataFrame) -> pd.Series:
    """Rules 1 and 2, computed from count and mean.

    This is the calculation itself. The rollup runs it once per row and stores
    the answer in readings_daily.is_complete (flag_complete, below); readers of
    readings_daily use that stored flag, and only data with no flag -- the
    history files in Storage, the simulation's rebuilt days -- is computed here
    at read time, with this same function.
    """
    if df.empty:
        return pd.Series(dtype=bool, index=df.index)
    count = pd.to_numeric(df["count"], errors="coerce")
    mean = pd.to_numeric(df["mean"], errors="coerce")

    # The station's typical day, which tells us its cadence.
    typical = count.groupby([df[k] for k in _cadence_keys(df)]).transform(
        lambda s: s.quantile(CADENCE_QUANTILE))
    per_day = typical.gt(CADENCE_SPLIT).map(
        {True: READINGS_PER_DAY_15MIN, False: READINGS_PER_DAY_HOURLY})
    needed = per_day * MIN_HOURS_FOR_COMPLETE_DAY / 24

    return count.ge(needed) & mean.between(VALID_MIN, VALID_MAX)


def complete_mask(df: pd.DataFrame) -> pd.Series:
    """True for each row that is a complete, plausible day (rules 1 and 2).

    Uses the stored readings_daily.is_complete flag where a row has one, and
    computes it (computed_complete_mask) where it does not.
    """
    if df.empty:
        return pd.Series(dtype=bool, index=df.index)
    computed = computed_complete_mask(df)
    if "is_complete" not in df.columns:
        return computed
    stored = df["is_complete"]
    return stored.where(stored.notna(), computed).astype(bool)


def flag_complete(new_rows: pd.DataFrame, reference: pd.DataFrame) -> pd.Series:
    """is_complete for rows the rollup is about to write.

    `reference` is the station's recent readings_daily rows (count, mean,
    source), so the cadence is judged on a fair sample of its days rather than
    on the handful being rolled up. Returns a mask aligned to `new_rows`.
    """
    cols = ["monitor_id", "pollutant", "source", "count", "mean"]
    ref = reference[cols].copy() if not reference.empty else pd.DataFrame(columns=cols)
    # Drop reference rows that are being rewritten, so no day counts twice.
    if not ref.empty and "date" in reference.columns:
        rewritten = set(zip(new_rows["monitor_id"], new_rows["pollutant"], new_rows["date"]))
        keep = [k not in rewritten for k in
                zip(reference["monitor_id"], reference["pollutant"], reference["date"])]
        ref = ref[keep]
    both = pd.concat([new_rows[cols].assign(_new=True), ref.assign(_new=False)],
                     ignore_index=True)
    mask = computed_complete_mask(both)
    return pd.Series(mask[both["_new"].values].values, index=new_rows.index)


def complete_days(df: pd.DataFrame) -> pd.DataFrame:
    """Only the rows that pass complete_mask."""
    return df[complete_mask(df)]


def station_day_aqi(complete: pd.DataFrame,
                    rule: str = DEFAULT_AQI_RULE) -> pd.DataFrame:
    """Composite AQI per (monitor_id, date), from rows that are ALREADY complete.

    Each pollutant's daily mean becomes its sub-index; the AQI is the largest.
    A day that does not meet the AQI rule (rule 3) gets no AQI at all.

    Returns monitor_id, date, aqi, dominant (the pollutant that set the max),
    plus any extra key columns (e.g. city) that are constant per monitor.
    """
    from scripts.ingest.lib.aqi_utils import compute_subindex

    spec = AQI_RULES[rule]
    cols = ["monitor_id", "date", "aqi", "dominant"]
    if complete.empty:
        return pd.DataFrame(columns=cols)

    sub = complete.copy()
    sub["si"] = [compute_subindex(p, float(v))
                 for p, v in zip(sub["pollutant"], sub["mean"])]
    sub = sub.dropna(subset=["si"])

    # Vectorised per station-day checks -- a Python lambda per station-day is
    # far too slow over 15 years of history.
    keys = [sub["monitor_id"], sub["date"]]
    ok = sub["pollutant"].groupby(keys).transform("nunique") >= spec["min_pollutants"]
    for p in spec["required_all"]:
        ok &= sub["pollutant"].eq(p).groupby(keys).transform("any")
    if spec["required_any"]:
        ok &= sub["pollutant"].isin(spec["required_any"]).groupby(keys).transform("any")
    sub = sub[ok]
    if sub.empty:
        return pd.DataFrame(columns=cols)

    top = sub.loc[sub.groupby(["monitor_id", "date"])["si"].idxmax()]
    out = top.rename(columns={"si": "aqi", "pollutant": "dominant"})
    extra = [c for c in ("city",) if c in out.columns]
    return out[cols + extra].reset_index(drop=True)


def station_day_values(df: pd.DataFrame, pollutant: str,
                       rule: str = DEFAULT_AQI_RULE) -> pd.DataFrame:
    """The daily value the forecast uses, per (monitor_id, date).

    `df` is raw readings_daily-shaped rows (any completeness). Returns columns
    monitor_id, date, value -- only for days that pass the rules above.
    For 'aqi' the value is the composite AQI; otherwise the pollutant's mean.
    """
    complete = complete_days(df)
    if pollutant == "aqi":
        aqi = station_day_aqi(complete, rule)
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
