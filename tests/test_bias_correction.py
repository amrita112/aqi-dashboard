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
    BIAS_CORRECT_MODES,
    DAMPING,
    MAX_RELATIVE_SHIFT,
    MIN_DAYS,
    WINDOW_DAYS,
    apply_corrections,
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
    out = city_day_errors(fc, {("m1", "2026-10-05", "aqi"): 120.0}, {"m1": "Delhi"})
    assert out[("Delhi", "aqi")][date(2026, 10, 5)] == pytest.approx(-20.0)


def test_falls_back_to_value_when_no_correction_was_applied():
    fc = [{"monitor_id": "m1", "pollutant": "aqi", "target_date": "2026-10-05",
           "value": 100.0, "value_raw": None}]
    out = city_day_errors(fc, {("m1", "2026-10-05", "aqi"): 120.0}, {"m1": "Delhi"})
    assert out[("Delhi", "aqi")][date(2026, 10, 5)] == pytest.approx(-20.0)


def test_averages_stations_within_a_city():
    fc = [
        {"monitor_id": "m1", "pollutant": "aqi", "target_date": "2026-10-05",
         "value": 100.0, "value_raw": None},
        {"monitor_id": "m2", "pollutant": "aqi", "target_date": "2026-10-05",
         "value": 140.0, "value_raw": None},
    ]
    actuals = {("m1", "2026-10-05", "aqi"): 120.0, ("m2", "2026-10-05", "aqi"): 120.0}
    out = city_day_errors(fc, actuals, {"m1": "Delhi", "m2": "Delhi"})
    assert out[("Delhi", "aqi")][date(2026, 10, 5)] == pytest.approx(0.0)


def test_skips_forecasts_with_no_observation():
    fc = [{"monitor_id": "m1", "pollutant": "aqi", "target_date": "2026-10-05",
           "value": 100.0, "value_raw": None}]
    assert city_day_errors(fc, {}, {"m1": "Delhi"}) == {}



# ── each pollutant is scored against itself (audit Nov 2026, §7.1) ──────────

class _FakeQuery:
    """Stands in for a Supabase query: every filter returns itself, and
    execute() hands back the canned rows once (so pagination stops)."""

    def __init__(self, rows):
        self.rows = rows

    def __getattr__(self, name):
        return lambda *a, **k: self

    def execute(self):
        class R:
            pass
        r = R()
        r.data, self.rows = self.rows, []
        return r


class _FakeClient:
    def __init__(self, tables):
        self.tables = tables

    def table(self, name):
        return _FakeQuery(list(self.tables[name]))


def test_pm25_forecast_is_not_scored_against_aqi():
    """The bug: actuals were keyed by (monitor, date) only, so the AQI value
    overwrote PM2.5 and a perfect PM2.5 forecast looked 107 too low."""
    fc = [
        {"monitor_id": "m1", "pollutant": "pm25", "target_date": "2026-10-05",
         "value": 60.0, "value_raw": None},
        {"monitor_id": "m1", "pollutant": "aqi", "target_date": "2026-10-05",
         "value": 150.0, "value_raw": None},
    ]
    actuals = {("m1", "2026-10-05", "pm25"): 60.0,
               ("m1", "2026-10-05", "aqi"): 167.0}
    out = city_day_errors(fc, actuals, {"m1": "Delhi"})
    assert out[("Delhi", "pm25")][date(2026, 10, 5)] == pytest.approx(0.0)
    assert out[("Delhi", "aqi")][date(2026, 10, 5)] == pytest.approx(-17.0)


def test_load_scored_history_keeps_pollutants_apart():
    """End to end through nightly's loader, as in the audit's demo: a perfect
    PM2.5 forecast must produce zero error and no correction."""
    from scripts.forecast import nightly_forecast as nf

    today = date(2026, 11, 14)
    fc, rd = [], []
    for i in range(1, 11):
        d = (today - timedelta(days=i)).isoformat()
        fc.append({"monitor_id": "m1", "pollutant": "pm25", "target_date": d,
                   "value": 60.0, "value_raw": None})
        rd.append({"monitor_id": "m1", "pollutant": "pm25", "date": d,
                   "mean": 60.0, "count": 96})
        rd.append({"monitor_id": "m1", "pollutant": "pm10", "date": d,
                   "mean": 200.0, "count": 96})
    client = _FakeClient({"forecast_daily": fc, "readings_daily": rd})
    hist_fc, actuals = nf.load_scored_history(
        client, ["pm25", "aqi"], today - timedelta(days=21))

    yesterday = (today - timedelta(days=1)).isoformat()
    assert actuals[("m1", yesterday, "pm25")] == pytest.approx(60.0)
    errors = city_day_errors(hist_fc, actuals, {"m1": "Delhi"})
    assert all(e == pytest.approx(0.0) for e in errors[("Delhi", "pm25")].values())
    assert decide(errors[("Delhi", "pm25")], today)["applied"] is False


# ── which rows get corrected: forecast/outlook yes, seasonal_normal no ───────

def _row(mode: str, h: int, city: str = "Delhi", value: float = 100.0) -> dict:
    return {"city_key": city, "pollutant": "pm25", "mode": mode,
            "horizon_days": h, "value": value}


def test_seasonal_normal_rows_are_never_corrected():
    """A row labelled "typical for this time of year" must stay the seasonal
    average, even in a city whose correction is switched on tonight."""
    decisions = {("Delhi", "pm25"): {"applied": True, "offset": -20.0}}
    rows = [_row("forecast", 1), _row("outlook", 2), _row("seasonal_normal", 3),
            *[_row("seasonal_normal", h) for h in range(4, 8)]]
    counts = apply_corrections(rows, decisions)

    shifted = 100.0 - DAMPING * -20.0
    assert rows[0]["value"] == pytest.approx(shifted) and rows[0]["value_raw"] == 100.0
    assert rows[1]["value"] == pytest.approx(shifted) and rows[1]["value_raw"] == 100.0
    for r in rows[2:]:
        assert r["value"] == 100.0
        assert r["value_raw"] is None, "a seasonal-normal row was marked as corrected"
    assert counts == {"corrected": 2, "city_not_applied": 0, "mode_excluded": 5}


def test_forecast_rows_on_any_day_are_corrected():
    """The rule is by label, not by day: a forecast-labelled row is corrected
    whatever its horizon."""
    decisions = {("Delhi", "pm25"): {"applied": True, "offset": 10.0}}
    rows = [_row("forecast", h) for h in range(1, 8)]
    assert apply_corrections(rows, decisions)["corrected"] == 7


def test_city_gate_still_decides_first():
    """The per-city APPLY/skip decision is unchanged: a city that is not being
    corrected keeps every row as it was, forecast or not."""
    decisions = {("Delhi", "pm25"): {"applied": True, "offset": -20.0},
                 ("Mumbai", "pm25"): {"applied": False, "offset": -20.0}}
    rows = [_row("forecast", 1, "Mumbai"), _row("outlook", 2, "Mumbai"),
            _row("forecast", 1, "Pune"),      # no decision at all
            _row("forecast", 1, "Delhi")]
    counts = apply_corrections(rows, decisions)
    assert [r["value"] for r in rows[:3]] == [100.0, 100.0, 100.0]
    assert all(r["value_raw"] is None for r in rows[:3])
    assert rows[3]["value"] != 100.0
    assert counts == {"corrected": 1, "city_not_applied": 3, "mode_excluded": 0}


def test_stale_value_raw_is_cleared():
    """A row upserted over last night's corrected row must not inherit its
    value_raw when it is not corrected tonight."""
    decisions = {("Delhi", "pm25"): {"applied": True, "offset": -20.0}}
    rows = [{**_row("seasonal_normal", 3), "value_raw": 87.0}]
    apply_corrections(rows, decisions)
    assert rows[0]["value_raw"] is None and rows[0]["value"] == 100.0


def test_modes_are_configurable():
    """Adding seasonal_normal back restores the old correct-everything rule."""
    assert "seasonal_normal" not in BIAS_CORRECT_MODES
    decisions = {("Delhi", "pm25"): {"applied": True, "offset": -20.0}}
    rows = [_row("seasonal_normal", 5)]
    apply_corrections(rows, decisions,
                      modes=BIAS_CORRECT_MODES + ("seasonal_normal",))
    assert rows[0]["value_raw"] == 100.0
