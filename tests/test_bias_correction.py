"""Tests for the running forecast bias correction.

The two things that must not break: the correction may never see the future,
and it must switch itself off where it does not help.
"""
from __future__ import annotations

import sys
from datetime import date, timedelta
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.forecast.bias_correction import (  # noqa: E402
    DAMPING,
    MAX_RELATIVE_SHIFT,
    MIN_DAYS,
    WINDOW_DAYS,
    apply_offset,
    city_day_errors,
    decide,
    offset_for,
)

TODAY = date(2026, 10, 8)


def errs(**kw: float) -> dict:
    """{day offset from TODAY: error}, so tests read in days-ago."""
    return {TODAY - timedelta(days=int(k[1:])): v for k, v in kw.items()}


# ── the correction may never see the future ──────────────────────────────────

def test_offset_excludes_the_day_being_corrected():
    """The whole honesty of this rests on `before` being exclusive."""
    e = errs(d0=1000.0, d1=-10.0, d2=-10.0, d3=-10.0)
    off = offset_for(e, TODAY)
    assert off == pytest.approx(-10.0), "today's own error leaked into its correction"


def test_offset_excludes_days_beyond_the_window():
    e = errs(d1=-10.0, d2=-10.0, d3=-10.0, d4=-500.0, d9=-500.0)
    assert offset_for(e, TODAY) == pytest.approx(-10.0)


def test_offset_needs_a_minimum_of_days():
    assert offset_for(errs(d1=-10.0), TODAY) is None
    assert offset_for({}, TODAY) is None
    e = errs(**{f"d{i}": -10.0 for i in range(1, MIN_DAYS + 1)})
    assert offset_for(e, TODAY) is not None


def test_window_is_the_documented_length():
    # A day exactly WINDOW_DAYS back is inside; one further back is not.
    inside = {TODAY - timedelta(days=WINDOW_DAYS): -40.0,
              TODAY - timedelta(days=1): -40.0}
    assert offset_for(inside, TODAY) == pytest.approx(-40.0)
    outside = {TODAY - timedelta(days=WINDOW_DAYS + 1): -999.0,
               TODAY - timedelta(days=1): -40.0,
               TODAY - timedelta(days=2): -40.0}
    assert offset_for(outside, TODAY) == pytest.approx(-40.0)


# ── self-policing ────────────────────────────────────────────────────────────

def test_applies_when_the_bias_is_consistent():
    """A steady under-forecast is exactly what this exists to fix."""
    e = {TODAY - timedelta(days=i): -30.0 for i in range(1, 9)}
    d = decide(e, TODAY)
    assert d["applied"] is True
    assert d["offset"] == pytest.approx(-30.0)
    assert d["mae_corrected"] < d["mae_raw"]


def test_declines_when_the_error_is_noise():
    """Mumbai's case: a small bias that alternates sign.

    Correcting this adds variance for nothing, and the live code has to reach
    that conclusion by itself rather than by a hardcoded city name.
    """
    e = {TODAY - timedelta(days=i): (12.0 if i % 2 else -12.0) for i in range(1, 11)}
    d = decide(e, TODAY)
    assert d["applied"] is False
    assert "too small" in d["reason"] or "MAE" in d["reason"]


def test_declines_without_enough_history():
    d = decide({TODAY - timedelta(days=1): -30.0}, TODAY)
    assert d["applied"] is False
    assert d["offset"] == 0.0


def test_switches_off_when_the_season_turns():
    """A correction learned on a ramp must stop once the ramp does.

    Older days under-forecast heavily; recent days do not. The replay should
    find that correcting no longer helps and switch off without intervention.
    """
    e = {}
    for i in range(1, 11):
        e[TODAY - timedelta(days=i)] = -45.0 if i > 5 else 2.0
    d = decide(e, TODAY)
    assert d["applied"] is False, "kept correcting after the bias disappeared"


# ── applying it ──────────────────────────────────────────────────────────────

def test_under_forecast_is_raised_and_over_forecast_lowered():
    assert apply_offset(100.0, -20.0) == pytest.approx(100 + DAMPING * 20)
    assert apply_offset(100.0, 20.0) == pytest.approx(100 - DAMPING * 20)


def test_never_returns_a_negative_forecast():
    assert apply_offset(5.0, 400.0) >= 0.0


def test_shift_is_capped_relative_to_the_forecast():
    """One bad day of observations must not swamp the forecast."""
    out = apply_offset(100.0, -1000.0)
    assert out <= 100.0 * (1 + MAX_RELATIVE_SHIFT) + 1e-9


# ── assembling city errors ───────────────────────────────────────────────────

def test_learns_from_value_raw_not_the_corrected_value():
    """Otherwise the offset chases its own tail."""
    fc = [{"monitor_id": "m1", "pollutant": "aqi", "target_date": "2026-10-05",
           "value": 150.0, "value_raw": 100.0}]
    out = city_day_errors(fc, {("m1", "2026-10-05"): 120.0}, {"m1": "Delhi"})
    assert out[("Delhi", "aqi")][date(2026, 10, 5)] == pytest.approx(-20.0)


def test_falls_back_to_value_when_no_correction_was_applied():
    fc = [{"monitor_id": "m1", "pollutant": "aqi", "target_date": "2026-10-05",
           "value": 100.0, "value_raw": None}]
    out = city_day_errors(fc, {("m1", "2026-10-05"): 120.0}, {"m1": "Delhi"})
    assert out[("Delhi", "aqi")][date(2026, 10, 5)] == pytest.approx(-20.0)


def test_averages_stations_within_a_city():
    fc = [
        {"monitor_id": "m1", "pollutant": "aqi", "target_date": "2026-10-05",
         "value": 100.0, "value_raw": None},
        {"monitor_id": "m2", "pollutant": "aqi", "target_date": "2026-10-05",
         "value": 140.0, "value_raw": None},
    ]
    actuals = {("m1", "2026-10-05"): 120.0, ("m2", "2026-10-05"): 120.0}
    out = city_day_errors(fc, actuals, {"m1": "Delhi", "m2": "Delhi"})
    assert out[("Delhi", "aqi")][date(2026, 10, 5)] == pytest.approx(0.0)


def test_skips_forecasts_with_no_observation():
    fc = [{"monitor_id": "m1", "pollutant": "aqi", "target_date": "2026-10-05",
           "value": 100.0, "value_raw": None}]
    assert city_day_errors(fc, {}, {"m1": "Delhi"}) == {}

