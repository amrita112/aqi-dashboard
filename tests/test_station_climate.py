"""Tests for the Historical trends builder (scripts/climate/build_station_climate.py).

Tiny hand-made inputs, so each expected number can be checked by eye. These pin:
  * only complete days count (same rule as the forecast, daily_quality.py)
  * a day's AQI: official mean from daily means; low/high from the day's
    extremes, the way the app's history chart builds them
  * year/month bucketing straight off the IST date string
  * one copy of a day that appears in two inputs
"""
from __future__ import annotations

import sys
from datetime import date, timedelta
from pathlib import Path

import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.climate.build_station_climate import (  # noqa: E402
    build,
    daily_values,
    monthly_climate,
    stack_sources,
)
from scripts.forecast.daily_quality import complete_days  # noqa: E402
from scripts.ingest.lib.aqi_utils import compute_subindex  # noqa: E402


def day_rows(monitor, pollutant, start, n, mean=100.0, lo=50.0, hi=200.0,
             count=24, source="xkdr", inp="xkdr_daily_history.parquet"):
    """n consecutive days for one station and pollutant (hourly cadence)."""
    return [{"monitor_id": monitor, "pollutant": pollutant, "source": source,
             "input": inp, "date": (start + timedelta(days=i)).isoformat(),
             "count": count, "mean": mean, "min": lo, "max": hi}
            for i in range(n)]


def frame(*groups):
    return pd.DataFrame([r for g in groups for r in g])


# ─── Complete-day filter ─────────────────────────────────────────────────────

def test_incomplete_days_are_left_out():
    """An hourly station needs >= 12 readings; a day with 5 must not count."""
    good = day_rows("m1", "pm25", date(2024, 11, 1), 10, mean=200.0)
    thin = day_rows("m1", "pm25", date(2024, 11, 11), 1, mean=20.0, count=5)
    out = build([frame(good, thin)], log=lambda *_: None)
    nov = out[(out.metric == "pm25") & (out.month == 11)].iloc[0]
    assert nov.n_days == 10
    assert nov.mean_of_means == 200.0          # the thin day's 20 is not averaged in


def test_stored_is_complete_flag_wins():
    """readings_daily rows carry the rollup's verdict; it is used as stored."""
    rows = day_rows("m1", "pm25", date(2026, 9, 1), 3, count=96, source="openaq",
                    inp="readings_daily")
    df = frame(rows)
    df["is_complete"] = [True, False, True]
    out = build([df], log=lambda *_: None)
    assert out[out.metric == "pm25"].iloc[0].n_days == 2


def test_out_of_range_values_dropped():
    """Daily means outside 0-2000 are instrument faults."""
    rows = day_rows("m1", "pm25", date(2024, 1, 1), 5) + \
        day_rows("m1", "pm25", date(2024, 1, 6), 1, mean=5000.0)
    out = build([frame(rows)], log=lambda *_: None)
    assert out[out.metric == "pm25"].iloc[0].n_days == 5


# ─── AQI ─────────────────────────────────────────────────────────────────────

def test_aqi_needs_both_pms():
    """Default AQI rule: no PM10 that day -> no AQI that day."""
    pm25 = day_rows("m1", "pm25", date(2024, 6, 1), 4)
    pm10 = day_rows("m1", "pm10", date(2024, 6, 1), 2, mean=150.0, lo=80.0, hi=300.0)
    daily = daily_values(complete_days(frame(pm25, pm10)))
    assert (daily.metric == "aqi").sum() == 2
    assert (daily.metric == "pm25").sum() == 4


def test_aqi_mean_min_max_match_the_app():
    """mean = max sub-index of daily MEANS (the official AQI); min/max = max
    sub-index of each pollutant's daily min / max (lib/api/data.ts)."""
    pm25 = day_rows("m1", "pm25", date(2024, 6, 1), 1, mean=100.0, lo=40.0, hi=250.0)
    pm10 = day_rows("m1", "pm10", date(2024, 6, 1), 1, mean=150.0, lo=90.0, hi=420.0)
    daily = daily_values(complete_days(frame(pm25, pm10)))
    aqi = daily[daily.metric == "aqi"].iloc[0]
    assert aqi["mean"] == max(compute_subindex("pm25", 100.0), compute_subindex("pm10", 150.0))
    assert aqi["min"] == max(compute_subindex("pm25", 40.0), compute_subindex("pm10", 90.0))
    assert aqi["max"] == max(compute_subindex("pm25", 250.0), compute_subindex("pm10", 420.0))


def test_negative_minimum_is_skipped_not_fatal():
    """A negative reading cannot be sub-indexed; the app skips it, so do we."""
    pm25 = day_rows("m1", "pm25", date(2024, 6, 1), 1, mean=100.0, lo=-3.0)
    pm10 = day_rows("m1", "pm10", date(2024, 6, 1), 1, mean=150.0, lo=90.0)
    daily = daily_values(complete_days(frame(pm25, pm10)))
    assert daily[daily.metric == "aqi"].iloc[0]["min"] == compute_subindex("pm10", 90.0)


# ─── Bucketing ───────────────────────────────────────────────────────────────

def test_ist_dates_bucket_by_their_own_calendar_day(monkeypatch):
    """31 Dec and 1 Jan land in their own months and years, whatever the
    machine's timezone: the date string is never parsed as an instant."""
    monkeypatch.setenv("TZ", "America/Los_Angeles")
    daily = pd.DataFrame([
        {"monitor_id": "m1", "metric": "pm25", "date": "2025-12-31",
         "mean": 10.0, "min": 5.0, "max": 20.0, "source": "openaq_archive"},
        {"monitor_id": "m1", "metric": "pm25", "date": "2026-01-01",
         "mean": 30.0, "min": 15.0, "max": 60.0, "source": "openaq_archive"},
    ])
    out = monthly_climate(daily)
    assert list(zip(out.year, out.month, out.mean_of_means)) == [(2025, 12, 10.0), (2026, 1, 30.0)]


def test_monthly_statistics():
    """Averages of daily mean/min/max, lowest/highest daily mean, percentiles."""
    means = [10.0, 20.0, 30.0, 40.0]
    daily = pd.DataFrame([
        {"monitor_id": "m1", "metric": "pm25", "date": f"2024-03-0{i + 1}",
         "mean": m, "min": m / 2, "max": m * 2, "source": "xkdr"}
        for i, m in enumerate(means)
    ])
    r = monthly_climate(daily).iloc[0]
    assert (r.year, r.month, r.n_days) == (2024, 3, 4)
    assert r.mean_of_means == 25.0
    assert r.mean_of_mins == 12.5
    assert r.mean_of_maxes == 50.0
    assert (r.lowest_daily_mean, r.highest_daily_mean) == (10.0, 40.0)
    assert r.p10_daily_mean == pytest.approx(13.0)
    assert r.p90_daily_mean == pytest.approx(37.0)
    assert r.sources == "xkdr"


def test_month_straddling_two_sources_names_both():
    """Sep 2025: 1 Sep from XKDR, the rest from the OpenAQ archive."""
    daily = pd.DataFrame([
        {"monitor_id": "m1", "metric": "pm25", "date": "2025-09-01",
         "mean": 10.0, "min": 5.0, "max": 20.0, "source": "xkdr"},
        {"monitor_id": "m1", "metric": "pm25", "date": "2025-09-02",
         "mean": 10.0, "min": 5.0, "max": 20.0, "source": "openaq_archive"},
    ])
    assert monthly_climate(daily).iloc[0].sources == "openaq_archive,xkdr"


# ─── Stacking and monitors ───────────────────────────────────────────────────

def test_duplicate_day_keeps_our_own_rollup():
    """The same station-pollutant-day in two inputs is counted once, from the
    higher-priority input (readings_daily first)."""
    ours = day_rows("m1", "pm25", date(2026, 8, 20), 1, mean=50.0, source="openaq",
                    inp="readings_daily")
    archive = day_rows("m1", "pm25", date(2026, 8, 20), 1, mean=99.0,
                       source="openaq_archive", inp="openaq_archive_daily_history.parquet")
    df, dropped = stack_sources([frame(archive), frame(ours)])
    assert dropped == 1
    assert df.iloc[0]["mean"] == 50.0


def test_unknown_monitors_are_dropped():
    """The table's foreign key would reject them; drop before writing."""
    rows = day_rows("m1", "pm25", date(2024, 1, 1), 3) + day_rows("ghost", "pm25", date(2024, 1, 1), 3)
    out = build([frame(rows)], known_monitors={"m1"}, log=lambda *_: None)
    assert set(out.monitor_id) == {"m1"}
