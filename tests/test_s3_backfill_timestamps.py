"""Tests for the S3 backfill's timestamp convention and lookup window.

WHY THIS EXISTS. Every OpenAQ value is an average over a short period. The
live API labels it with the period START, the S3 archive with the period END.
Until 2026-11-16 the backfill stored the S3 END as-is, so the same measurement
landed one slot later than its live copy: ~1% duplicate readings and some
values attached to the neighbouring reading. Separately, the lookup of
already-stored readings used UTC-day bounds while each S3 file holds an India
day, so the first ~4.75h of each file fell outside it and those measurements
were dropped silently.

These tests pin both fixes without touching the network or the database.
"""
from __future__ import annotations

import sys
from pathlib import Path
from typing import Any, Dict, List

import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.ingest.daily_backfill_s3 import (  # noqa: E402
    infer_period_minutes,
    lookup_bounds,
    period_start_utc,
    rows_to_ingest,
)
from scripts.ingest.lib.config import DEFAULT_S3_PERIOD_MINUTES  # noqa: E402

LAT, LON = 28.646835, 77.316032


def s3_rows(sensor: int, parameter: str, units: str,
            local_ends: List[str], values: List[float]) -> List[Dict[str, Any]]:
    """Rows shaped like the OpenAQ S3 CSV (datetime = period END, +05:30)."""
    return [
        {"location_id": 235, "sensors_id": sensor, "location": "Anand Vihar",
         "datetime": t, "lat": LAT, "lon": LON, "parameter": parameter,
         "units": units, "value": v}
        for t, v in zip(local_ends, values)
    ]


def with_ts_end(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df["ts_end"] = pd.to_datetime(df["datetime"], utc=True)
    return df


# ─── Interval inference ────────────────────────────────────────────────────

def test_infers_15_minutes_from_spacing():
    df = pd.DataFrame(s3_rows(1, "no2", "ppb",
        ["2026-11-08T23:00:00+05:30", "2026-11-08T23:15:00+05:30",
         "2026-11-08T23:30:00+05:30"], [33.2, 50.5, 42.7]))
    assert set(infer_period_minutes(with_ts_end(df))) == {15.0}


def test_infers_60_minutes_for_hourly_sensor():
    df = pd.DataFrame(s3_rows(2, "pm25", "µg/m³",
        ["2026-11-08T21:00:00+05:30", "2026-11-08T22:00:00+05:30",
         "2026-11-08T23:00:00+05:30"], [100, 110, 120]))
    assert set(infer_period_minutes(with_ts_end(df))) == {60.0}


def test_median_ignores_occasional_missing_slot():
    # 15-min sensor with one 45-minute hole: gaps 15, 15, 45, 15 -> median 15.
    df = pd.DataFrame(s3_rows(1, "no2", "ppb",
        ["2026-11-08T20:00:00+05:30", "2026-11-08T20:15:00+05:30",
         "2026-11-08T20:30:00+05:30", "2026-11-08T21:15:00+05:30",
         "2026-11-08T21:30:00+05:30"], [1, 2, 3, 4, 5]))
    assert set(infer_period_minutes(with_ts_end(df))) == {15.0}


def test_each_sensor_gets_its_own_period():
    df = pd.DataFrame(
        s3_rows(1, "no2", "ppb",
                ["2026-11-08T22:15:00+05:30", "2026-11-08T22:30:00+05:30"], [1, 2])
        + s3_rows(2, "pm25", "µg/m³",
                  ["2026-11-08T22:00:00+05:30", "2026-11-08T23:00:00+05:30"], [3, 4]))
    got = infer_period_minutes(with_ts_end(df))
    assert list(got) == [15.0, 15.0, 60.0, 60.0]


def test_single_row_sensor_borrows_station_cadence():
    df = pd.DataFrame(
        s3_rows(1, "no2", "ppb",
                ["2026-11-08T23:00:00+05:30", "2026-11-08T23:15:00+05:30",
                 "2026-11-08T23:30:00+05:30"], [1, 2, 3])
        + s3_rows(2, "so2", "ppb", ["2026-11-08T23:30:00+05:30"], [9]))
    got = infer_period_minutes(with_ts_end(df), default_minutes=60)
    assert got.iloc[-1] == 15.0   # from the other sensor, not the 60 default


def test_single_row_everywhere_uses_configurable_default():
    df = pd.DataFrame(s3_rows(1, "no2", "ppb", ["2026-11-08T23:30:00+05:30"], [42.7]))
    assert list(infer_period_minutes(with_ts_end(df))) == [float(DEFAULT_S3_PERIOD_MINUTES)]
    assert list(infer_period_minutes(with_ts_end(df), default_minutes=60)) == [60.0]


# ─── The shift: S3 period END -> period START (what the live API stores) ───

def test_anand_vihar_s3_row_matches_live_period_start():
    """Real case, Anand Vihar NO2, 8 Nov 2026.

    Live API:  period 17:45-18:00 UTC, value 42.7 ppb -> stored at 17:45 UTC.
    S3 file:   datetime 2026-11-08T23:30:00+05:30 (= 18:00 UTC), value 42.7.
    After the fix the S3 copy must land on 17:45 UTC, the live reading.
    """
    df = pd.DataFrame(s3_rows(12235607, "no2", "ppb",
        ["2026-11-08T23:00:00+05:30", "2026-11-08T23:15:00+05:30",
         "2026-11-08T23:30:00+05:30"], [33.2, 50.5, 42.7]))
    starts = period_start_utc(df)
    assert list(starts.dt.strftime("%H:%M")) == ["17:15", "17:30", "17:45"]

    readings, meas = rows_to_ingest(df, "monitor-av", "admin")
    last = readings[-1]
    assert last["recorded_at"] == "2026-11-08T17:45:00+00:00"
    assert meas[-1]["_reading_key"] == "monitor-av:2026-11-08T17:45:00+00:00"
    assert meas[-1]["pollutant"] == "no2"


def test_hourly_shift_is_one_hour():
    df = pd.DataFrame(s3_rows(2, "pm25", "µg/m³",
        ["2026-11-08T22:00:00+05:30", "2026-11-08T23:00:00+05:30"], [100, 110]))
    readings, _ = rows_to_ingest(df, "m", "admin")
    assert [r["recorded_at"] for r in readings] == [
        "2026-11-08T15:30:00+00:00", "2026-11-08T16:30:00+00:00"]


def test_unparseable_datetime_is_dropped_not_crashing():
    rows = s3_rows(1, "no2", "ppb",
        ["2026-11-08T23:15:00+05:30", "not-a-date", "2026-11-08T23:30:00+05:30"],
        [1, 2, 3])
    readings, _ = rows_to_ingest(pd.DataFrame(rows), "m", "admin")
    assert [r["recorded_at"] for r in readings] == [
        "2026-11-08T17:30:00+00:00", "2026-11-08T17:45:00+00:00"]


# ─── Lookup window: the file's real span, not the UTC day ──────────────────

def test_lookup_bounds_cover_india_day_file():
    # The file named 20261108 starts at 00:45 IST on 8 Nov = 19:15 UTC on
    # 7 Nov (period end) and ends 23:30 IST = 18:00 UTC on 8 Nov.
    df = pd.DataFrame(s3_rows(12235607, "no2", "ppb",
        ["2026-11-08T00:45:00+05:30", "2026-11-08T01:00:00+05:30",
         "2026-11-08T23:15:00+05:30", "2026-11-08T23:30:00+05:30"],
        [32.1, 31.7, 50.5, 42.7]))
    readings, _ = rows_to_ingest(df, "m", "admin")
    start, end = lookup_bounds(readings)
    # Period starts: 19:00 UTC on 7 Nov .. 17:45 UTC on 8 Nov. The old
    # UTC-day window (8 Nov 00:00-24:00 UTC) would have missed the start.
    assert start == "2026-11-07T19:00:00+00:00"
    assert end == "2026-11-08T17:45:00+00:00"
    assert start < "2026-11-08T00:00:00+00:00"


def test_lookup_bounds_normalise_formats_and_empty():
    assert lookup_bounds([]) is None
    rows = [{"recorded_at": "2026-11-08T17:45:00Z"},
            {"recorded_at": "2026-11-07T19:00:00+00:00"}]
    assert lookup_bounds(rows) == ("2026-11-07T19:00:00+00:00",
                                   "2026-11-08T17:45:00+00:00")


class FakeQuery:
    """Records the filters a Supabase query chain applies."""

    def __init__(self):
        self.filters: List[tuple] = []

    def __getattr__(self, name):
        def call(*args):
            self.filters.append((name, *args))
            return self
        return call

    def execute(self):
        return type("R", (), {"data": []})()


def test_fetch_existing_uses_inclusive_span():
    from scripts.ingest.daily_backfill_s3 import fetch_existing_readings_for_lookup
    q = FakeQuery()
    client = type("C", (), {"table": lambda self, name: q})()
    fetch_existing_readings_for_lookup(
        client, ["m"], "2026-11-07T19:00:00+00:00", "2026-11-08T17:45:00+00:00")
    assert ("gte", "recorded_at", "2026-11-07T19:00:00+00:00") in q.filters
    assert ("lte", "recorded_at", "2026-11-08T17:45:00+00:00") in q.filters
