"""
A Python mirror of the app's TypeScript serving layer, for the verification
notebook.

WHY THIS EXISTS. The nightly job (Python) writes ONE daily number per station.
What a user sees is then built in TypeScript, at request time:

  lib/api/forecast.ts  expandDay            daily value x diurnal ratio for each
                                            IST hour, plus the band around it
  lib/api/data.ts      averageForecastDays  the plain mean over the nearest
                                            stations, matched BY DATE, leaving
                                            out seasonal_normal stations when a
                                            neighbour has a real forecast
  database-setup/23-…  nearest_monitors     the k = 3 nearest LIVE official
                                            stations within 25 km (SQL/PostGIS)

A Jupyter notebook cannot run TypeScript, so this file copies those three steps
line for line. It must not drift from them: tests/fixtures/serving_mirror/
cases.json is checked by BOTH tests/test_serving_mirror.py (this file) and
tests/api/serving-mirror.test.ts (the real TypeScript), so a change to one side
that is not made on the other fails a test.

WHAT IS NOT MIRRORED (and why it does not matter for the notebook's numbers)
  * Band colours and category labels (`band` on each day/hour). They are a
    lookup on the value, not a number the notebook scores.
  * The distance itself. PostGIS measures on the WGS84 ellipsoid; haversine
    here measures on a sphere. The two differ by under 0.5%, which can only
    change which station is 3rd-nearest when two are almost exactly equally
    far away.
  * The "live station" test needs the database (an OpenAQ day in the last 14
    days). The caller passes the set of live monitor ids instead.

No database access, no file access: plain functions on plain dicts.
"""

from __future__ import annotations

import math
from datetime import date
from typing import Any, Dict, Iterable, List, Optional, Sequence

# lib/api/data.ts: DEFAULT_NEAREST_K, DEFAULT_MAX_KM
DEFAULT_NEAREST_K = 3
DEFAULT_MAX_KM = 25.0

EARTH_RADIUS_KM = 6371.0088  # mean Earth radius


# ─── Small helpers that copy JavaScript behaviour exactly ────────────────────

def round1(n: float) -> float:
    """JavaScript's Math.round(n * 10) / 10.

    Python's round() sends halves to the nearest EVEN number (round(0.25, 1)
    is 0.2); JavaScript's Math.round sends them UP (0.3). Using round() here
    would make the mirror disagree with the app on exact halves.
    """
    return math.floor(n * 10 + 0.5) / 10


def mean_across(values: Iterable[Optional[float]]) -> Optional[float]:
    """lib/api/data.ts meanAcross: mean of the finite values, rounded to 0.1.

    Missing values (None / NaN) are left out rather than counted as zero.
    Returns None when nothing is left.
    """
    usable = [float(v) for v in values
              if v is not None and isinstance(v, (int, float)) and math.isfinite(v)]
    if not usable:
        return None
    return round1(sum(usable) / len(usable))


def days_between_ist(from_date: str, to_date: str) -> int:
    """lib/api/time.ts daysBetweenIst: whole IST calendar days from a to b."""
    return (date.fromisoformat(to_date) - date.fromisoformat(from_date)).days


# ─── lib/api/forecast.ts ─────────────────────────────────────────────────────

def index_shape(rows: Iterable[Dict[str, Any]]) -> Dict[str, List[float]]:
    """indexShape: (city|pollutant|month) -> 24 ratios indexed by IST hour.

    A missing hour is a thin cell, not a zero, so it defaults to 1 (the day's
    mean).
    """
    out: Dict[str, List[float]] = {}
    for r in rows:
        key = f"{r['city']}|{r['pollutant']}|{int(r['month'])}"
        arr = out.setdefault(key, [1.0] * 24)
        hour = int(r["hour"])
        if 0 <= hour < 24:
            arr[hour] = float(r["ratio"])
    return out


def headline_for(mode: str, days_ahead: int) -> str:
    """headlineFor: the plain-language heading that matches the mode."""
    if mode == "seasonal_normal":
        return "Typical for this time of year — no recent reading to predict from"
    word = "Outlook" if mode == "outlook" else "Forecast"
    if days_ahead <= 0:
        return f"{word} for today"
    if days_ahead == 1:
        return f"{word} for tomorrow"
    return f"{word}, {days_ahead} days ahead"


def expand_day(row: Dict[str, Any], city: str, shape: Dict[str, List[float]],
               today: str, hourly: bool = True) -> Dict[str, Any]:
    """expandDay: one stored forecast_daily row -> the day the app displays.

    `row` has forecast_daily's columns. `city` is the ANALYSIS city name
    ("Delhi", "Bengaluru"), which is what diurnal_shape is keyed by. `today` is
    the IST date the app is answering on.

      hour value = daily value x shape ratio for (city, pollutant, month, hour)
      band       = value x (1 -/+ band_p80)      (None for seasonal_normal)
    """
    value = float(row["value"])
    band_p80 = row.get("band_p80")
    days_ahead = days_between_ist(today, row["target_date"])
    # Age counted to TODAY, not to the night the row was computed.
    if row.get("based_on_date"):
        data_age = days_between_ist(row["based_on_date"], today)
    else:
        data_age = row.get("data_age_days")
    month = int(row["target_date"][5:7])
    ratios = shape.get(f"{city}|{row['pollutant']}|{month}")

    band_low = None if band_p80 is None else round1(value * (1 - band_p80))
    band_high = None if band_p80 is None else round1(value * (1 + band_p80))

    hours = None
    if hourly:
        hours = []
        for hour in range(24):
            v = round1(value * (ratios[hour] if ratios else 1.0))
            hours.append({
                "hour": hour,
                "local_time": f"{row['target_date']}T{hour:02d}:00",
                "value": v,
                "band_low": None if band_p80 is None else round1(v * (1 - band_p80)),
                "band_high": None if band_p80 is None else round1(v * (1 + band_p80)),
            })

    return {
        "target_date": row["target_date"],
        "horizon_days": row["horizon_days"],
        "value": round1(value),
        "band_low": band_low,
        "band_high": band_high,
        "mode": row["mode"],
        "headline": headline_for(row["mode"], days_ahead),
        "model": row["model"],
        "based_on_date": row.get("based_on_date"),
        "data_age_days": data_age,
        "hourly": hours,
        "hourly_is_flat": not ratios,
    }


# ─── lib/api/data.ts ─────────────────────────────────────────────────────────

def average_forecast_days(per_station: Sequence[Dict[str, Any]],
                          horizon_count: int) -> Optional[Dict[str, Any]]:
    """averageForecastDays: the forecast for a PLACE, from its nearest stations.

    `per_station` is a list of {"monitor": {...id, name, distance_km},
    "days": [expand_day(...), ...]}, nearest station first.

    For each date (matched BY DATE, never by position in the list):
      * stations whose day is seasonal_normal are left out whenever at least
        one station has a real forecast for that date;
      * the value, bands, data age and every hour are the plain mean of the
        stations that are left (rounded to 0.1, as the app does);
      * the mode is the first contributing station's, or seasonal_normal when
        none of them had a real forecast.

    Returns {"value": [day, ...], "stations": [...]} or None.
    """
    with_data = [p for p in per_station if p["days"]]
    if not with_data:
        return None

    out: List[Dict[str, Any]] = []
    used: Dict[str, Dict[str, Any]] = {}
    dates = sorted({d["target_date"] for p in with_data for d in p["days"]})[:horizon_count]

    for target in dates:
        slice_ = []
        for p in with_data:
            day = next((d for d in p["days"] if d["target_date"] == target), None)
            if day is not None:
                slice_.append({"monitor": p["monitor"], "day": day})
        if not slice_:
            continue

        real = [x for x in slice_ if x["day"]["mode"] != "seasonal_normal"]
        contributing = real if real else slice_
        for c in contributing:
            used[c["monitor"]["id"]] = c["monitor"]

        base = contributing[0]["day"]

        def mean(pick):
            return mean_across(pick(c["day"]) for c in contributing)

        hourly = None
        if base["hourly"]:
            hourly = []
            for hour, h in enumerate(base["hourly"]):
                def at(d, field, hour=hour):
                    hs = d.get("hourly")
                    return hs[hour][field] if hs and hour < len(hs) else None
                value = mean(lambda d: at(d, "value"))
                hourly.append({
                    **h,
                    "value": value if value is not None else h["value"],
                    "band_low": mean(lambda d: at(d, "band_low")),
                    "band_high": mean(lambda d: at(d, "band_high")),
                })

        day_value = mean(lambda d: d["value"])
        data_age = mean(lambda d: d["data_age_days"])
        out.append({
            **base,
            "value": day_value if day_value is not None else base["value"],
            "band_low": mean(lambda d: d["band_low"]),
            "band_high": mean(lambda d: d["band_high"]),
            # Only a real forecast if the rows behind it were.
            "mode": base["mode"] if real else "seasonal_normal",
            "data_age_days": data_age if data_age is not None else base["data_age_days"],
            "hourly": hourly,
            "hourly_is_flat": all(c["day"]["hourly_is_flat"] for c in contributing),
        })

    if not out:
        return None
    ordered = sorted(used.values(), key=lambda m: m["distance_km"])
    stations = [{"monitor_id": m["id"], "name": m.get("name"),
                 "distance_km": m["distance_km"]} for m in ordered]
    return {"value": out, "stations": stations}


# ─── database-setup/23-write-functions-live-monitors.sql: nearest_monitors ──

def haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Great-circle distance in km (sphere; PostGIS uses the ellipsoid)."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(math.sqrt(a))


def nearest_stations(lat: float, lng: float, stations: Iterable[Dict[str, Any]],
                     k: int = DEFAULT_NEAREST_K, max_km: float = DEFAULT_MAX_KM,
                     live_ids: Optional[Iterable[str]] = None) -> List[Dict[str, Any]]:
    """nearest_monitors: the k nearest live stations within max_km, nearest first.

    `stations` are manifest entries (scripts/ingest/target_stations.json:
    monitor_id, name, city, latitude, longitude). The manifest lists only
    official OpenAQ stations, which matches the SQL's `openaq:%` filter.
    `live_ids`, when given, stands in for the SQL's "has an OpenAQ day in the
    last 14 days" test; None means treat every station as live.

    Returns dicts shaped like lib/api/data.ts NearbyMonitor: id, name, city,
    latitude, longitude, distance_km (rounded to 0.01 as the app does).
    """
    live = set(live_ids) if live_ids is not None else None
    found = []
    for s in stations:
        if live is not None and s["monitor_id"] not in live:
            continue
        km = haversine_km(lat, lng, float(s["latitude"]), float(s["longitude"]))
        if km <= max_km:
            found.append({"id": s["monitor_id"], "name": s.get("name"),
                          "city": s.get("city"), "latitude": s["latitude"],
                          "longitude": s["longitude"], "distance_km": km})
    found.sort(key=lambda m: m["distance_km"])
    for m in found:
        # Math.round(km * 100) / 100, with JavaScript's halves-go-up rounding.
        m["distance_km"] = math.floor(m["distance_km"] * 100 + 0.5) / 100
    return found[:k]
