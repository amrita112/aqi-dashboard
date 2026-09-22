"""
The pipeline has two clocks. This pins the boundary between them.

INSTANTS are stored UTC (readings.recorded_at, min_ts, max_ts). CALENDAR
LABELS are grouped by IST (readings_daily.date, forecast_daily.target_date,
diurnal_shape.hour, the climatology's day-of-year).

An instant survives any timezone -- it converts losslessly on read. A calendar
label does not: once a daily mean is averaged over the wrong 24 hours, no
downstream conversion recovers it, and raw readings are pruned at 30 days. So
the grouping has to be right when it is WRITTEN.

Getting this wrong cost two bugs, found 2026-09-22:
  - readings_daily.date meant an IST day for XKDR rows and a UTC day for ours,
    so every anomaly subtracted an IST-day climatology from a UTC-day reading
  - diurnal_shape.hour is an IST hour and was being looked up by UTC hour,
    rotating every hourly profile by 5h30m

Run:  /usr/bin/python3 -m pytest tests/test_time_base.py -v
"""

from __future__ import annotations

import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))

from scripts.ingest.lib.config import (  # noqa: E402
    IST, ist_day_bounds_utc, ist_today, to_ist_day)


def test_ist_is_five_and_a_half_hours_ahead():
    assert IST.utcoffset(None) == timedelta(hours=5, minutes=30)


def test_ist_day_starts_at_1830_utc_the_previous_day():
    """The boundary the whole fix turns on."""
    start, end = ist_day_bounds_utc(date(2026, 9, 15))
    assert start == datetime(2026, 9, 14, 18, 30, tzinfo=timezone.utc)
    assert end == datetime(2026, 9, 15, 18, 30, tzinfo=timezone.utc)


def test_ist_day_is_exactly_24_hours():
    """India has no daylight saving, so no day is 23 or 25 hours long."""
    for d in (date(2026, 1, 1), date(2026, 3, 29), date(2026, 10, 25),
              date(2026, 12, 31), date(2024, 2, 29)):
        start, end = ist_day_bounds_utc(d)
        assert end - start == timedelta(days=1), d


def test_bounds_are_half_open_and_tile_without_gap_or_overlap():
    """Consecutive days must not double-count or drop a reading."""
    d = date(2026, 9, 15)
    _, end_first = ist_day_bounds_utc(d)
    start_second, _ = ist_day_bounds_utc(d + timedelta(days=1))
    assert end_first == start_second


@pytest.mark.parametrize("utc_str,expected", [
    # 18:29 UTC is still the same IST day; 18:30 UTC starts the next one.
    ("2026-09-15T18:29:59+00:00", date(2026, 9, 15)),
    ("2026-09-15T18:30:00+00:00", date(2026, 9, 16)),
    # Midnight UTC is 05:30 IST -- the same calendar day, which is why a UTC
    # rollup looked plausible and was still wrong.
    ("2026-09-15T00:00:00+00:00", date(2026, 9, 15)),
    # 20:00 UTC is 01:30 IST the NEXT day. A UTC-day rollup files this under
    # the 15th; a person in India lived it on the 16th.
    ("2026-09-15T20:00:00+00:00", date(2026, 9, 16)),
])
def test_to_ist_day_maps_instants_to_the_indian_calendar(utc_str, expected):
    assert to_ist_day(datetime.fromisoformat(utc_str)) == expected


def test_a_reading_belongs_to_the_day_whose_bounds_contain_it():
    """to_ist_day and ist_day_bounds_utc must agree; they are used separately."""
    ts = datetime(2026, 9, 15, 20, 0, tzinfo=timezone.utc)
    day = to_ist_day(ts)
    start, end = ist_day_bounds_utc(day)
    assert start <= ts < end


def test_utc_and_ist_grouping_genuinely_differ():
    """Guards against an 'IST' helper that silently reduces to UTC."""
    ts = datetime(2026, 9, 15, 22, 0, tzinfo=timezone.utc)
    assert ts.date() == date(2026, 9, 15)
    assert to_ist_day(ts) == date(2026, 9, 16)


def test_ist_today_does_not_depend_on_machine_timezone():
    """CI runs in UTC; the answer must still be India's date."""
    assert ist_today() == datetime.now(IST).date()


def test_rollup_and_prune_use_the_same_bounds():
    """Verified-then-deleted must mean the same rows in both scripts.

    prune_raw only deletes a day whose raw measurement count reconciles with
    readings_daily. If it sliced the day differently from rollup_daily the
    counts would never match -- a safe failure, but nothing would ever prune.
    """
    import inspect
    from scripts.ingest import prune_raw, rollup_daily
    for mod in (rollup_daily, prune_raw):
        src = inspect.getsource(mod)
        assert "ist_day_bounds_utc" in src, f"{mod.__name__} builds its own bounds"
        assert 'T00:00:00+00:00' not in src, (
            f"{mod.__name__} still slices a day at UTC midnight")


def test_simulation_converts_to_ist_before_taking_date_or_hour():
    """The diurnal shape is IST-indexed; observations must be too."""
    import inspect
    from scripts.forecast import simulate
    src = inspect.getsource(simulate.build_observation_frame)
    assert "tz_convert" in src, "observations are not converted to IST on read"
