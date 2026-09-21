"""
Mean number of PM2.5 measurements per day returned by
/v3/sensors/{id}/measurements for CPCB reference stations in five Indian
cities. CPCB publishes at 15-minute resolution, so a complete day is 96.

Requires an OpenAQ API key in OPENAQ_API_KEY, plus requests, pandas, matplotlib.
Takes ~15 minutes because of the request throttle.
"""

import os
import time
from collections import defaultdict
from datetime import datetime, timedelta, timezone

import matplotlib.pyplot as plt
import pandas as pd
import requests

API = "https://api.openaq.org/v3"
HEADERS = {"X-API-Key": os.environ["OPENAQ_API_KEY"]}

PARAMETER = "pm25"
DAYS_BACK = 30
EXPECTED_PER_DAY = 96
PAGE_LIMIT = 1000
MAX_PAGES = 6
THROTTLE_S = 1.2

# Bounding boxes as (lat_min, lon_min, lat_max, lon_max)
CITY_BOXES = {
    "Delhi":     (28.40, 76.80, 28.90, 77.50),
    "Mumbai":    (18.85, 72.75, 19.30, 73.05),
    "Bengaluru": (12.80, 77.40, 13.15, 77.80),
    "Kolkata":   (22.40, 88.20, 22.80, 88.50),
    "Hyderabad": (17.20, 78.20, 17.60, 78.70),
}
# Reference stations carry the agency name; this excludes private sensors.
AGENCIES = ("CPCB", "DPCC", "MPCB", "KSPCB", "WBPCB", "TSPCB", "UPPCB")


_last_call = 0.0


def get(path, **params):
    """Throttled GET. On a 429, waits for the rate-limit window to reset and
    retries; gives up after three attempts."""
    global _last_call
    for _ in range(3):
        wait = THROTTLE_S - (time.monotonic() - _last_call)
        if wait > 0:
            time.sleep(wait)
        r = requests.get(f"{API}{path}", headers=HEADERS, params=params, timeout=40)
        _last_call = time.monotonic()
        if r.status_code == 429:
            reset = int(r.headers.get("x-ratelimit-reset", 10))
            print(f"429; sleeping {reset + 1}s")
            time.sleep(reset + 1)
            continue
        r.raise_for_status()
        return r.json()
    raise RuntimeError("rate limited repeatedly; stopping")


def stations():
    """(city, pm25 sensor id) for every reference station in CITY_BOXES."""
    out = []
    for city, (la1, lo1, la2, lo2) in CITY_BOXES.items():
        for loc in get("/locations", bbox=f"{lo1},{la1},{lo2},{la2}", limit=1000)["results"]:
            if not any(a in (loc.get("name") or "") for a in AGENCIES):
                continue
            for s in loc.get("sensors") or []:
                if s["parameter"]["name"] == PARAMETER:
                    out.append((city, s["id"]))
                    break
    return out


def daily_counts(sensor_id, since):
    """Number of measurements per UTC day for one sensor."""
    counts = defaultdict(int)
    for page in range(1, MAX_PAGES + 1):
        rows = get(f"/sensors/{sensor_id}/measurements",
                   datetime_from=since.isoformat(), limit=PAGE_LIMIT, page=page)["results"]
        for r in rows:
            stamp = r["period"]["datetimeTo"]["utc"]
            counts[datetime.fromisoformat(stamp.replace("Z", "+00:00")).date()] += 1
        if len(rows) < PAGE_LIMIT:
            break
    return counts


def main():
    now = datetime.now(timezone.utc)
    since = now - timedelta(days=DAYS_BACK)
    days = [(since + timedelta(days=k)).date() for k in range(DAYS_BACK + 1)]

    rows, cities = [], []
    for i, (city, sensor_id) in enumerate(stations(), 1):
        try:
            counts = daily_counts(sensor_id, since)
        except requests.HTTPError as e:
            print(f"[{i}] sensor {sensor_id}: {e}")
            continue
        rows.append([counts.get(d, 0) for d in days])
        cities.append(city)
        print(f"[{i}] {city} sensor {sensor_id}: {sum(counts.values())} readings")

    # Stations x days; a station that returned nothing counts as zero.
    df = pd.DataFrame(rows, columns=days)
    per_city = df.groupby(pd.Series(cities)).mean()

    fig, ax = plt.subplots(figsize=(12, 5.2))
    x = range(len(days))
    for city in CITY_BOXES:
        if city in per_city.index:
            ax.plot(x, per_city.loc[city], lw=1.4, label=f"{city} (n={cities.count(city)})")
    ax.plot(x, df.mean(), color="black", lw=2.4, label=f"All cities (n={len(df)})")
    ax.axhline(EXPECTED_PER_DAY, color="#888", ls="--", lw=1)
    ax.text(0, EXPECTED_PER_DAY + 1.5, f"complete 15-min day = {EXPECTED_PER_DAY}",
            fontsize=8, color="#666")
    ax.set_xticks(list(x))
    ax.set_xticklabels([d.strftime("%d %b") for d in days], rotation=90, fontsize=8)
    ax.set_ylim(0, EXPECTED_PER_DAY * 1.12)
    ax.set_ylabel("mean readings per station")
    ax.legend(fontsize=8, loc="upper right", ncol=2)
    ax.grid(axis="y", alpha=0.3)
    ax.set_title(
        f"Mean {PARAMETER.upper()} readings per station per day, CPCB reference stations in "
        f"{', '.join(CITY_BOXES)}\n"
        f"OpenAQ /v3/sensors/{{id}}/measurements, {days[0]:%d %b} – {days[-1]:%d %b %Y}",
        loc="left", fontsize=11, fontweight="bold")
    plt.tight_layout()
    plt.savefig("openaq_india_pm25_coverage.png", dpi=140, facecolor="white")


if __name__ == "__main__":
    main()
