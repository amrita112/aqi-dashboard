"""readings.aqi_value follows its measurements, and the rollup flags complete days.

Fake Supabase client throughout; nothing touches the live database.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.ingest.lib.aqi_rule import composite_aqi, meets_aqi_rule  # noqa: E402
from scripts.ingest.lib.aqi_utils import compute_subindex  # noqa: E402


# ── the per-timestamp AQI rule ──────────────────────────────────────────────

def test_so2_alone_is_no_longer_an_aqi():
    """The audit's demo: SO2 = 20 alone was stored as AQI 25 'Good'."""
    assert composite_aqi({"so2": 20.0}) is None


def test_both_pms_give_the_max_subindex():
    got = composite_aqi({"pm25": 75.0, "pm10": 180.0, "no2": 40.0})
    assert got == max(compute_subindex("pm25", 75.0), compute_subindex("pm10", 180.0),
                      compute_subindex("no2", 40.0))


def test_cpcb_rule_is_available():
    assert meets_aqi_rule({"pm25", "no2", "so2"}, "cpcb")
    assert not meets_aqi_rule({"pm25", "no2", "so2"})


def test_daily_and_hourly_rules_agree():
    """station_day_aqi (daily) and composite_aqi (per timestamp) read the same
    rule; check them on every subset of the four pollutants."""
    from itertools import combinations
    from scripts.forecast.daily_quality import station_day_aqi
    pols = ["pm25", "pm10", "no2", "so2"]
    for n in range(1, 5):
        for combo in combinations(pols, n):
            df = pd.DataFrame([{"monitor_id": "m", "date": "2026-11-01", "pollutant": p,
                                "mean": 50.0, "count": 96} for p in combo])
            daily_has = not station_day_aqi(df).empty
            hourly_has = composite_aqi({p: 50.0 for p in combo}) is not None
            assert daily_has == hourly_has, combo


# ── refreshing aqi_value ────────────────────────────────────────────────────

class FakeQuery:
    def __init__(self, client, table):
        self.client, self.table_name, self.ids = client, table, None

    def select(self, *_):
        return self

    def in_(self, col, ids):
        self.ids = set(ids)
        return self

    def order(self, *_a, **_k):
        return self

    def range(self, lo, hi):
        self.lo, self.hi = lo, hi
        return self

    def execute(self):
        rows = [m for m in self.client.measurements if m["reading_id"] in self.ids]
        class R:
            pass
        r = R()
        r.data = rows[self.lo:self.hi + 1]
        return r


class FakeClient:
    def __init__(self, measurements):
        self.measurements = measurements
        self.rpc_calls = []

    def table(self, name):
        assert name == "measurements"
        return FakeQuery(self, name)

    def rpc(self, name, params):
        self.rpc_calls.append((name, params))
        class Q:
            def execute(_self):
                class R:
                    pass
                r = R()
                r.data = len(params["p_ids"])
                return r
        return Q()


def test_reading_gaining_pm_gets_its_aqi_recomputed():
    """A timestamp first seen with only NO2 (so no AQI), then PM2.5 and PM10
    arrive in a later run: its aqi_value must now be the PM-driven AQI."""
    from scripts.ingest.lib.supabase_client import refresh_reading_aqi
    client = FakeClient([
        {"reading_id": "r1", "pollutant": "no2", "value": 40.0},
        {"reading_id": "r1", "pollutant": "pm25", "value": 120.0},
        {"reading_id": "r1", "pollutant": "pm10", "value": 260.0},
        {"reading_id": "r2", "pollutant": "so2", "value": 20.0},   # still SO2 only
    ])
    refresh_reading_aqi(client, ["r1", "r2"])
    name, params = client.rpc_calls[0]
    assert name == "set_reading_aqi"
    got = dict(zip(params["p_ids"], params["p_values"]))
    assert got["r1"] == composite_aqi({"no2": 40.0, "pm25": 120.0, "pm10": 260.0})
    assert got["r2"] is None


def test_nothing_to_refresh_makes_no_call():
    from scripts.ingest.lib.supabase_client import refresh_reading_aqi
    client = FakeClient([])
    assert refresh_reading_aqi(client, []) == 0
    assert client.rpc_calls == []


# ── the rollup's is_complete flag ───────────────────────────────────────────

def test_rollup_flags_partial_days_but_still_writes_them():
    from scripts.ingest.rollup_daily import add_complete_flags
    # Two weeks of full 15-minute days as the station's reference ...
    reference = pd.DataFrame([{"monitor_id": "m1", "pollutant": "pm25", "source": "openaq",
                               "date": f"2026-11-{d:02d}", "count": 96, "mean": 80.0}
                              for d in range(1, 15)])
    # ... then the window being rolled: one full day, one 6-hour day.
    rows = [
        {"monitor_id": "m1", "pollutant": "pm25", "date": "2026-11-15", "count": 95, "mean": 90.0},
        {"monitor_id": "m1", "pollutant": "pm25", "date": "2026-11-16", "count": 24, "mean": 40.0},
    ]
    add_complete_flags(rows, reference)
    assert [r["is_complete"] for r in rows] == [True, False]


def test_stored_flag_wins_over_recomputing():
    """Readers use the rollup's verdict; only unflagged rows are computed."""
    from scripts.forecast.daily_quality import complete_mask
    df = pd.DataFrame([
        {"monitor_id": "m", "pollutant": "pm25", "date": "2026-11-01", "count": 96, "mean": 50.0,
         "is_complete": False},                           # the rollup said no
        {"monitor_id": "m", "pollutant": "pm25", "date": "2026-11-02", "count": 96, "mean": 50.0,
         "is_complete": None},                            # unflagged: computed -> yes
    ])
    assert complete_mask(df).tolist() == [False, True]
