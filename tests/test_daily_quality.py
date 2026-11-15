"""Tests for the shared daily completeness rule (scripts/forecast/daily_quality.py).

These pin the three rules nightly, the refit and the notebook all rely on:
>= 16 hours of readings, values 0-2000, and >= 3 pollutants incl. a PM for AQI.
"""
from __future__ import annotations

import sys
from datetime import date, timedelta
from pathlib import Path

import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.forecast.daily_quality import (  # noqa: E402
    complete_mask,
    station_day_aqi,
    station_day_values,
)


def rows(monitor, pollutant, counts, means=None, source="openaq", start=date(2026, 11, 1)):
    """One row per day, with the given counts (and means, default 100)."""
    means = means or [100.0] * len(counts)
    return [{"monitor_id": monitor, "pollutant": pollutant, "source": source,
             "date": (start + timedelta(days=i)).isoformat(),
             "count": c, "mean": m} for i, (c, m) in enumerate(zip(counts, means))]


def test_15_minute_station_needs_64_readings():
    """A 15-minute station (typical day 96) needs 16 h = 64 readings."""
    df = pd.DataFrame(rows("m1", "pm25", [96] * 10 + [64, 63]))
    assert complete_mask(df).tolist() == [True] * 11 + [False]


def test_hourly_station_needs_16_readings():
    """An hourly station (typical day 24) needs 16 readings, not 64."""
    df = pd.DataFrame(rows("m1", "pm25", [24] * 10 + [16, 15]))
    assert complete_mask(df).tolist() == [True] * 11 + [False]


def test_cadence_is_per_source():
    """Hourly XKDR history and 15-minute OpenAQ days on one monitor are
    judged against their own cadence."""
    df = pd.DataFrame(rows("m1", "pm25", [24] * 5, source="xkdr")
                      + rows("m1", "pm25", [96] * 5 + [20], source="openaq",
                             start=date(2026, 12, 1)))
    mask = complete_mask(df).tolist()
    assert mask[:5] == [True] * 5          # 24 is a full hourly day
    assert mask[-1] is False               # 20 is not a 15-minute day


def test_single_reading_day_is_rejected():
    """The audit's case: one 15-minute reading counted as a full day."""
    df = pd.DataFrame(rows("m1", "no2", [96] * 10 + [1]))
    assert complete_mask(df).iloc[-1] == False  # noqa: E712


def test_implausible_values_are_rejected():
    df = pd.DataFrame(rows("m1", "pm25", [96] * 3, means=[-1.0, 100.0, 2500.0]))
    assert complete_mask(df).tolist() == [False, True, False]


def _day(monitor, d, **means):
    return [{"monitor_id": monitor, "pollutant": p, "date": d, "source": "openaq",
             "count": 96, "mean": v} for p, v in means.items()]


def test_default_rule_needs_both_pms():
    df = pd.DataFrame(
        _day("m1", "2026-11-10", pm25=180.0, pm10=320.0)               # OK: both PMs
        + _day("m1", "2026-11-11", pm25=180.0, no2=60.0, so2=20.0)     # no PM10
        + _day("m2", "2026-11-12", pm10=150.0, no2=60.0, so2=20.0))    # no PM2.5
    got = station_day_aqi(df)
    assert set(zip(got.monitor_id, got.date)) == {("m1", "2026-11-10")}


def test_cpcb_rule_needs_three_pollutants_including_a_pm():
    df = pd.DataFrame(
        _day("m1", "2026-11-10", pm25=180.0, pm10=320.0, no2=60.0)   # OK
        + _day("m1", "2026-11-11", pm25=180.0, pm10=320.0)           # only 2
        + _day("m1", "2026-11-12", no2=60.0, so2=20.0, pm10=50.0)    # OK, PM10 is the PM
        + _day("m2", "2026-11-12", no2=60.0, so2=20.0))              # no PM, only 2
    got = station_day_aqi(df, rule="cpcb")
    assert set(zip(got.monitor_id, got.date)) == {("m1", "2026-11-10"), ("m1", "2026-11-12")}


def test_shared_cases_match_the_fixture():
    """The same cases tests/api/daily-quality.test.ts checks the TypeScript
    against, so the two implementations cannot drift apart."""
    import json
    from scripts.forecast.daily_quality import complete_days
    cases = json.loads((Path(__file__).parent / "fixtures" / "daily_quality"
                        / "cases.json").read_text())
    df = pd.DataFrame(cases["rows"])
    assert complete_mask(df).tolist() == cases["expected"]["complete"]
    for rule in ("both_pm", "cpcb"):
        got = station_day_aqi(complete_days(df), rule).sort_values(["monitor_id", "date"])
        want = cases["expected"][f"aqi_{rule}"]
        assert [(r.monitor_id, r.date, r.aqi, r.dominant) for r in got.itertuples()] == \
               [(w["monitor_id"], w["date"], w["aqi"], w["dominant"]) for w in want]


def test_aqi_is_max_subindex_and_names_the_driver():
    from scripts.ingest.lib.aqi_utils import compute_subindex
    df = pd.DataFrame(_day("m1", "2026-11-10", pm25=180.0, pm10=320.0, no2=60.0))
    got = station_day_aqi(df).iloc[0]
    assert got.aqi == max(compute_subindex("pm25", 180.0),
                          compute_subindex("pm10", 320.0),
                          compute_subindex("no2", 60.0))
    assert got.dominant == "pm25"


def test_no2_only_day_cannot_become_the_aqi_anchor():
    """The audit's demo (§4.2): a day where only NO2 = 35 was published gave
    AQI 44 in place of the previous full day's 347."""
    df = pd.DataFrame(
        _day("m1", "2026-11-10", pm25=180.0, pm10=320.0, no2=60.0)
        + _day("m1", "2026-11-11", no2=35.0))
    got = station_day_values(df, "aqi")
    assert got.date.tolist() == ["2026-11-10"]


def test_pollutant_values_are_the_complete_means():
    df = pd.DataFrame(rows("m1", "pm25", [96, 96, 10], means=[50.0, 60.0, 900.0]))
    got = station_day_values(df, "pm25")
    assert got.value.tolist() == pytest.approx([50.0, 60.0])
