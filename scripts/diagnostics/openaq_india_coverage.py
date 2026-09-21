"""
Measure and plot recent data availability for India CPCB stations on OpenAQ.

Standalone and self-contained. Needs
only `requests`, `pandas`, `matplotlib` and an OpenAQ API key in OPENAQ_API_KEY.

In a sample of Indian CPCB reference stations, how many measurements does 
/v3/sensors/{id}/measurements return for each of the last N days, 
against the 96 a 15-minute feed should produce?
"""

from __future__ import annotations

import os
import sys
import time
from collections import defaultdict
from datetime import datetime, timedelta, timezone

import matplotlib.pyplot as plt
import pandas as pd
import requests

API = "https://api.openaq.org/v3"
KEY = os.environ.get("OPENAQ_API_KEY", "")
HEADERS = {"X-API-Key": KEY}

COUNTRY_ID_INDIA = 9
PARAMETER = "pm25"
DAYS_BACK = 30
MAX_STATIONS = 50
EXPECTED_PER_DAY = 96          # CPCB publishes at 15-minute resolution
THROTTLE_S = 1.2               # seconds between requests to avoid 429s
PAGE_LIMIT = 1000              # v3 maximum
MAX_PAGES = 6                  # 6000 readings covers 60+ days at 15-min spacing

# City bounding boxes
CITY_BOXES = {
    "Delhi":     (28.40, 76.80, 28.90, 77.50),
    "Mumbai":    (18.85, 72.75, 19.30, 73.05),
    "Bengaluru": (12.80, 77.40, 13.15, 77.80),
    "Kolkata":   (22.40, 88.20, 22.80, 88.50),
    "Hyderabad": (17.20, 78.20, 17.60, 78.70),
}

_last_call = 0.0


def get(path: str, **params):
    """Throttled GET. Backs off and retries once on 429."""
    global _last_call
    for attempt in range(3):
        wait = THROTTLE_S - (time.monotonic() - _last_call)
        if wait > 0:
            time.sleep(wait)
        r = requests.get(f"{API}{path}", headers=HEADERS, params=params, timeout=40)
        _last_call = time.monotonic()
        if r.status_code == 429:
            reset = int(r.headers.get("x-ratelimit-reset", 10))
            print(f"    429; sleeping {reset + 1}s", flush=True)
            time.sleep(reset + 1)
            continue
        r.raise_for_status()
        return r.json()
    raise RuntimeError("rate limited repeatedly")


def pick_stations():
    """Reference-grade CPCB stations, spread across five cities."""
    out = []
    per_city = max(1, MAX_STATIONS // len(CITY_BOXES))
    for city, (la1, lo1, la2, lo2) in CITY_BOXES.items():
        js = get("/locations", bbox=f"{lo1},{la1},{lo2},{la2}", limit=1000)
        cands = []
        for loc in js.get("results", []):
            name = loc.get("name") or ""
            # CPCB reference stations carry the agency in the name; this
            # filters out private sensors, which have a different
            # publication path and would muddy the picture.
            if not any(a in name for a in ("CPCB", "DPCC", "MPCB", "KSPCB",
                                           "WBPCB", "TSPCB", "UPPCB")):
                continue
            sensors = [s for s in (loc.get("sensors") or [])
                       if (s.get("parameter") or {}).get("name") == PARAMETER]
            if not sensors:
                continue
            last = (loc.get("datetimeLast") or {}).get("utc")
            cands.append({"city": city, "id": loc["id"], "name": name[:38],
                          "sensor": sensors[0]["id"], "last": last})
        # Prefer stations OpenAQ believes are current, so the sample is not
        # dominated by monitors that have been dark for years.
        cands.sort(key=lambda c: c["last"] or "", reverse=True)
        out += cands[:per_city]
    return out[:MAX_STATIONS]


def daily_counts(sensor_id: int, since: datetime):
    """Measurements per UTC day for one sensor, paginating the whole window.
    """
    counts = defaultdict(int)
    newest = None
    seen_first = None
    for page in range(1, MAX_PAGES + 1):
        js = get(f"/sensors/{sensor_id}/measurements",
                 datetime_from=since.isoformat(), limit=PAGE_LIMIT, page=page)
        rows = js.get("results", [])
        if not rows:
            break
        stamps = [(r.get("period") or {}).get("datetimeTo", {}).get("utc") for r in rows]
        stamps = [s for s in stamps if s]
        # If a page repeats the previous one, pagination is not working; stop
        if stamps and stamps[0] == seen_first:
            print("    pagination returned a repeated page; stopping", flush=True)
            break
        seen_first = stamps[0] if stamps else None
        for stamp in stamps:
            ts = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
            counts[ts.date()] += 1
            newest = ts if newest is None or ts > newest else newest
        if len(rows) < PAGE_LIMIT:
            break
    return counts, newest


def main():
    if not KEY:
        sys.exit("set OPENAQ_API_KEY")
    now = datetime.now(timezone.utc)
    since = now - timedelta(days=DAYS_BACK)

    print(f"OpenAQ India {PARAMETER} coverage, last {DAYS_BACK} days")
    print(f"now: {now:%Y-%m-%d %H:%M} UTC\n")

    stations = pick_stations()
    print(f"sampled {len(stations)} CPCB reference stations\n")

    grid, lags = {}, {}
    for i, st in enumerate(stations, 1):
        try:
            counts, newest = daily_counts(st["sensor"], since)
        except Exception as e:
            print(f"  [{i}/{len(stations)}] {st['name']}: {e}")
            continue
        label = f"{st['city']} · {st['name']}"
        grid[label] = counts
        lags[label] = (now - newest).total_seconds() / 3600 if newest else float("nan")
        print(f"  [{i}/{len(stations)}] {label}: {sum(counts.values())} readings, "
              f"newest {lags[label]:.0f}h old" if newest
              else f"  [{i}/{len(stations)}] {label}: no data in window")

    days = [(since + timedelta(days=k)).date() for k in range(DAYS_BACK + 1)]
    df = pd.DataFrame({lab: [grid[lab].get(d, 0) for d in days] for lab in grid},
                      index=days).T

    fig, ax = plt.subplots(figsize=(15, 0.42 * len(df) + 3.2))
    im = ax.imshow(df.values, aspect="auto", cmap="YlGnBu",
                   vmin=0, vmax=EXPECTED_PER_DAY)
    ax.set_xticks(range(len(days)))
    ax.set_xticklabels([d.strftime("%d %b") for d in days], rotation=90, fontsize=8)
    ax.set_yticks(range(len(df)))
    ax.set_yticklabels([f"{lab}   ({lags[lab]:.0f}h)" if lags[lab] == lags[lab]
                        else f"{lab}   (none)" for lab in df.index], fontsize=8)
    for i in range(df.shape[0]):
        for j in range(df.shape[1]):
            v = df.values[i, j]
            if v:
                ax.text(j, i, v, ha="center", va="center", fontsize=5.5,
                        color="white" if v > EXPECTED_PER_DAY * 0.55 else "#222")

    ax.set_title(
        f"OpenAQ /v3/sensors/{{id}}/measurements — {PARAMETER.upper()} readings per day, "
        f"India CPCB reference stations",
        loc="left", fontsize=13, fontweight="bold", pad=26)
    ax.text(0, 1.045,
            f"A complete 15-minute day is {EXPECTED_PER_DAY} readings (darkest). Blank = the "
            f"API returned nothing for that day. Station labels carry the age of that "
            f"station's newest reading.",
            transform=ax.transAxes, fontsize=9.5, color="#4a5560")
    fig.colorbar(im, ax=ax, label=f"readings returned (complete day = {EXPECTED_PER_DAY})",
                 shrink=0.6, pad=0.01)
    plt.tight_layout()
    out = "openaq_india_coverage.png"
    plt.savefig(out, dpi=140, facecolor="white", bbox_inches="tight")
    print(f"\nwrote {out}")

    ok = df.iloc[:, :-7]
    print(f"\nolder half of window: {(ok.values >= EXPECTED_PER_DAY * 0.9).mean():.0%} of "
          f"station-days at >=90% complete")
    recent = df.iloc[:, -7:]
    print(f"last 7 days        : {(recent.values >= EXPECTED_PER_DAY * 0.9).mean():.0%} of "
          f"station-days at >=90% complete")
    print(f"publication lag    : median {pd.Series(lags).median():.0f}h, "
          f"max {pd.Series(lags).max():.0f}h")


if __name__ == "__main__":
    main()
