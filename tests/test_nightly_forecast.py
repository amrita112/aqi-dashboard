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
