"""The notebook's Python copy of the app's serving layer (serving_mirror.py).

The cases file is shared with tests/api/serving-mirror.test.ts, which runs the
app's real TypeScript (expandDay, averageForecastDays) on the same inputs. Both
must reproduce `expected` exactly, which pins the mirror to the app.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.forecast.serving_mirror import (  # noqa: E402
    average_forecast_days,
    expand_day,
    haversine_km,
    index_shape,
    nearest_stations,
    round1,
)

CASES = json.loads((Path(__file__).parent / "fixtures" / "serving_mirror" / "cases.json")
                   .read_text())
SHAPE = index_shape(CASES["shape_rows"])


def test_expand_day_matches_shared_cases():
    for c in CASES["expand_cases"]:
        got = expand_day(c["row"], c["city"], SHAPE, c["today"])
        assert got == c["expected"], c["name"]


def test_average_forecast_days_matches_shared_cases():
    for c in CASES["average_cases"]:
        per = [{"monitor": s["monitor"],
                "days": [expand_day(r, s["city"], SHAPE, c["today"]) for r in s["rows"]]}
               for s in c["stations"]]
        assert average_forecast_days(per, c["horizon_count"]) == c["expected"], c["name"]


def test_round1_sends_halves_up_like_javascript():
    # Python's round(100.25, 1) is 100.2; Math.round gives 100.3.
    assert round1(100.25) == 100.3
    assert round1(-0.25) == -0.2   # Math.round(-2.5) is -2


def test_haversine_known_distance():
    # One degree of longitude on the equator is 111.195 km on this sphere.
    assert abs(haversine_km(0, 0, 0, 1) - 111.195) < 0.01
    # Connaught Place, Delhi -> CST, Mumbai: about 1,166 km great-circle.
    assert abs(haversine_km(28.6315, 77.2167, 18.9398, 72.8355) - 1166) < 5


def test_nearest_stations_k_radius_and_live_filter():
    stations = [
        {"monitor_id": "near", "name": "N", "latitude": 28.60, "longitude": 77.20},
        {"monitor_id": "mid", "name": "M", "latitude": 28.65, "longitude": 77.20},
        {"monitor_id": "far", "name": "F", "latitude": 28.70, "longitude": 77.20},
        {"monitor_id": "outside", "name": "O", "latitude": 29.10, "longitude": 77.20},
    ]
    got = nearest_stations(28.60, 77.20, stations)
    assert [m["id"] for m in got] == ["near", "mid", "far"]
    assert got[0]["distance_km"] == 0.0
    # The 25 km cap leaves out a station ~55 km away even when k is larger.
    assert "outside" not in [m["id"] for m in nearest_stations(28.60, 77.20, stations, k=10)]
    # A station that is not live is skipped, and the next one moves up.
    got = nearest_stations(28.60, 77.20, stations, live_ids={"mid", "far"})
    assert [m["id"] for m in got] == ["mid", "far"]
