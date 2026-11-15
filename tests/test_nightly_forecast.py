"""Tests for the nightly forecast's data handling and serving rules.

Uses a fake Supabase client so nothing touches the live database.
"""
from __future__ import annotations

import sys
from datetime import date, timedelta
from pathlib import Path

import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.forecast import nightly_forecast as nf  # noqa: E402


class FakeQuery:
    """Every filter returns itself; execute() returns the rows once."""

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


class FakeClient:
    def __init__(self, tables):
        self.tables = tables

    def table(self, name):
        return FakeQuery(list(self.tables.get(name, [])))


def daily(monitor, d, pollutant, mean, count=96):
    return {"monitor_id": monitor, "pollutant": pollutant, "date": d,
            "mean": mean, "count": count, "source": "openaq"}


def full_days(monitor, start, n, **means):
    """n complete days of the given pollutant means, from `start`."""
    out = []
    for i in range(n):
        d = (start + timedelta(days=i)).isoformat()
        out += [daily(monitor, d, p, v) for p, v in means.items()]
    return out


# ── the starting day must be complete (audit §7.3) ───────────────────────────

def test_partial_newest_day_is_skipped():
    """Nov 11 has only NO2, and a single reading of it. The forecast must
    start from Nov 10, the last complete day, for both PM2.5 and AQI."""
    rows = full_days("m1", date(2026, 11, 1), 10, pm25=180.0, pm10=320.0, no2=60.0)
    rows.append(daily("m1", "2026-11-11", "no2", 35.0, count=1))
    obs = nf.latest_observations(FakeClient({"readings_daily": rows}),
                                 ["pm25", "aqi"], date(2026, 11, 1))
    assert obs[("m1", "pm25")] == (date(2026, 11, 10), 180.0)
    assert obs[("m1", "aqi")][0] == date(2026, 11, 10)
    assert obs[("m1", "aqi")][1] > 300      # PM-driven, not NO2's 44


def test_half_published_pm25_day_is_skipped():
    rows = full_days("m1", date(2026, 11, 1), 10, pm25=100.0, pm10=150.0, no2=40.0)
    rows += [daily("m1", "2026-11-11", "pm25", 20.0, count=30),   # 7.5 hours
             daily("m1", "2026-11-11", "pm10", 30.0, count=30),
             daily("m1", "2026-11-11", "no2", 10.0, count=30)]
    obs = nf.latest_observations(FakeClient({"readings_daily": rows}),
                                 ["pm25"], date(2026, 11, 1))
    assert obs[("m1", "pm25")][0] == date(2026, 11, 10)


# ── the refit's history: same quality rule, no double-counted stations ──────

def test_history_from_db_filters_and_dedupes(tmp_path, monkeypatch):
    """Audit D2/D3. Two monitors (m1, m2) are copies of one XKDR station, and m3
    is a different station. The city mean must count the shared station once,
    each monitor must keep its own history, and partial days must be dropped."""
    from scripts.forecast.baselines import load_history_from_db

    start = date(2026, 1, 1)
    shared = full_days("m1", start, 5, pm25=100.25, pm10=150.5, no2=40.125)
    history = pd.DataFrame(
        shared
        + [dict(r, monitor_id="m2") for r in shared]                # the copy
        + full_days("m3", start, 5, pm25=40.75, pm10=80.5, no2=20.25)
        + [daily("m3", "2026-01-06", "pm25", 900.0, count=3)])     # partial
    history["source"] = "xkdr"
    history["count"] = history["count"].where(history["count"] != 96, 24)
    xkdr = tmp_path / "xkdr.parquet"
    history.to_parquet(xkdr)
    empty = tmp_path / "archive.parquet"
    history.iloc[0:0].to_parquet(empty)
    monkeypatch.setenv("XKDR_HISTORY_FILE", str(xkdr))
    monkeypatch.setenv("ARCHIVE_HISTORY_FILE", str(empty))

    client = FakeClient({
        "monitors": [{"id": m, "city": "Delhi NCR"} for m in ("m1", "m2", "m3")],
        "readings_daily": [],
    })
    got = load_history_from_db(client, min_stations=1,
                               since="2026-01-01", until="2026-12-31")

    # Every monitor keeps its own station history ...
    assert set(got["station_daily"].station) == {"m1", "m2", "m3"}
    # ... but the city mean counts the shared station once: (100.25 + 40.75) / 2
    city = got["daily"].set_index("d")
    assert city.loc["2026-01-01", "n_stations"] == 2
    assert city.loc["2026-01-01", "pm25"] == pytest.approx((100.25 + 40.75) / 2)
    # The 3-reading day never made it in.
    assert pd.Timestamp("2026-01-06") not in set(got["station_daily"].d)


# ── serving: the model, alpha and label all come from what was measured ─────

TODAY = date(2026, 11, 15)


def params(**kw):
    """A forecast_params row with a flat climatology of 100."""
    row = {"climatology": [0.0] + [100.0] * 366, "history_days": 2000,
           "alpha_h1": 0.9, "alpha_h2": 0.8, "alpha_h3": 0.7, "model": "blend",
           # alphas[e] = 1 - e/10, so each effective horizon is distinguishable
           "alphas": [0.0] + [round(1 - e / 10, 2) for e in range(1, 11)]}
    row.update(kw)
    return row


def modes_for(model="blend", mode="forecast", ages=range(0, 8)):
    return {("Delhi", "pm25", a, h): {"mode": mode, "model": model,
                                      "band_p50": 0.1, "band_p80": 0.2}
            for a in ages for h in (1, 2, 3)}


def rows_for(p, obs_age, obs_value, modes):
    obs = (TODAY - timedelta(days=obs_age), obs_value) if obs_age is not None else None
    return {r["horizon_days"]: r for r in
            nf.build_station_rows("m1", "Delhi", "pm25", p, obs, modes, TODAY, 7)}


def test_blend_uses_alpha_for_the_effective_horizon():
    """Audit §7.2: a 3-day-old reading forecasting day 2 must use alpha_5,
    not alpha_h3 (the old min(age + h, 3) rule)."""
    got = rows_for(params(), obs_age=3, obs_value=150.0, modes=modes_for())
    # clim 100 + alpha_5 (0.5) * anomaly 50
    assert got[2]["value"] == pytest.approx(125.0)
    assert got[2]["model"] == "blend"


def test_persistence_is_served_when_it_measured_better():
    """Audit D5: the model choice used to be copied into the label only."""
    got = rows_for(params(), obs_age=2, obs_value=150.0,
                   modes=modes_for(model="persistence"))
    for h in (1, 2, 3):
        assert got[h]["value"] == pytest.approx(150.0)
        assert got[h]["model"] == "persistence"
        assert got[h]["band_p80"] == pytest.approx(0.2)


def test_old_params_without_alphas_never_borrow_alpha_h3():
    """Rows fitted before the migration only have alpha_h1..3. Past effective
    horizon 3 there is no measured alpha, so the seasonal normal is served."""
    p = params(alphas=None)
    got = rows_for(p, obs_age=1, obs_value=150.0, modes=modes_for())
    assert got[1]["value"] == pytest.approx(100 + 0.8 * 50)   # alpha_h2
    assert got[2]["value"] == pytest.approx(100 + 0.7 * 50)   # alpha_h3
    assert got[3]["mode"] == "seasonal_normal"                # effective 4
    assert got[3]["value"] == pytest.approx(100.0)


def test_readings_older_than_measured_ages_get_the_seasonal_normal():
    got = rows_for(params(), obs_age=8, obs_value=150.0, modes=modes_for())
    assert all(r["mode"] == "seasonal_normal" for r in got.values())
    assert all(r["value"] == pytest.approx(100.0) for r in got.values())


def test_no_measured_mode_means_seasonal_normal_not_outlook():
    """It used to fall back to 'outlook' -- a claim of skill nobody measured."""
    got = rows_for(params(), obs_age=1, obs_value=150.0, modes={})
    assert got[1]["mode"] == "seasonal_normal"
    assert got[1]["value"] == pytest.approx(100.0)


def test_seasonal_normal_mode_serves_the_seasonal_normal():
    got = rows_for(params(), obs_age=1, obs_value=150.0,
                   modes=modes_for(mode="seasonal_normal"))
    assert got[1]["value"] == pytest.approx(100.0)
    assert got[1]["model"] == "climatology"


def test_days_4_to_7_are_the_seasonal_normal():
    got = rows_for(params(), obs_age=0, obs_value=150.0, modes=modes_for())
    for h in (4, 5, 6, 7):
        assert got[h]["mode"] == "seasonal_normal"
        assert got[h]["band_p80"] is None
