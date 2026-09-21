"""
Measure and plot recent data availability for India CPCB stations on OpenAQ.

Standalone and self-contained. Needs
only `requests`, `pandas`, `matplotlib` and an OpenAQ API key in OPENAQ_API_KEY.

For Indian CPCB reference stations in the chosen cities, how many measurements
does /v3/sensors/{id}/measurements return for each of the last N days, against
the 96 a 15-minute feed should produce?

Outputs (written to the current directory):
  openaq_india_coverage_counts.csv  the fetched data: one row per station,
                                    one column per day, plus city and lag_h
  openaq_india_coverage_stats.png   average readings per station per day, by
                                    city, over the window (always produced)
  openaq_india_coverage.png         per-station heatmap; only produced when
                                    MAX_STATIONS is set and <= HEATMAP_MAX_STATIONS,
                                    because it becomes unreadable beyond that

Run with --from-cache to redraw the figures from the CSV without calling the
API again (useful when only the plotting changes).
"""

from __future__ import annotations

import os
import sys
import time
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone

import matplotlib.pyplot as plt
import pandas as pd
import requests

API = "https://api.openaq.org/v3"
KEY = os.environ.get("OPENAQ_API_KEY", "")
HEADERS = {"X-API-Key": KEY}

COUNTRY_ID_INDIA = 9
PARAMETER = "pm25"
DAYS_BACK = 30
MAX_STATIONS = None            # None = every CPCB station in CITY_BOXES; an int caps the sample
HEATMAP_MAX_STATIONS = 20      # per-station heatmap only drawn at or below this many stations
EXPECTED_PER_DAY = 96          # CPCB publishes at 15-minute resolution
THROTTLE_S = 1.2               # seconds between requests to avoid 429s
PAGE_LIMIT = 1000              # v3 maximum
MAX_PAGES = 6                  # 6000 readings covers 60+ days at 15-min spacing
CACHE_CSV = "openaq_india_coverage_counts.csv"

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
    """Reference-grade CPCB stations across the chosen cities.

    With MAX_STATIONS = None every matching station is returned; otherwise the
    sample is split evenly across cities and capped at MAX_STATIONS."""
    out = []
    per_city = None if MAX_STATIONS is None else max(1, MAX_STATIONS // len(CITY_BOXES))
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
        out += cands if per_city is None else cands[:per_city]
    return out if MAX_STATIONS is None else out[:MAX_STATIONS]


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
    if "--from-cache" in sys.argv:
        df, lags = load_cache()
        make_figures(df, lags)
        return
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
    save_cache(df, lags)
    make_figures(df, lags)


def save_cache(df: pd.DataFrame, lags: dict):
    """Persist the fetched counts so the figures can be redrawn offline."""
    out = df.copy()
    out.columns = [d.isoformat() for d in out.columns]
    out.insert(0, "lag_h", pd.Series(lags))
    out.insert(0, "city", [lab.split(" · ")[0] for lab in out.index])
    out.index.name = "station"
    out.to_csv(CACHE_CSV)
    print(f"\nwrote {CACHE_CSV}")


def load_cache():
    """Inverse of save_cache: returns (df indexed by station with date columns, lags)."""
    raw = pd.read_csv(CACHE_CSV, index_col="station")
    lags = raw["lag_h"].to_dict()
    df = raw.drop(columns=["city", "lag_h"])
    df.columns = [date.fromisoformat(c) for c in df.columns]
    print(f"loaded {len(df)} stations x {df.shape[1]} days from {CACHE_CSV}")
    return df, lags


def make_figures(df: pd.DataFrame, lags: dict):
    days = list(df.columns)
    # City for each row of df, taken from the "City · station" label
    cities = pd.Series([lab.split(" · ")[0] for lab in df.index], index=df.index)

    plot_stats(df, cities, days)

    # The per-station heatmap only reads well for a small sample; with every
    # station in five cities it is hundreds of rows tall.
    if MAX_STATIONS is not None and MAX_STATIONS <= HEATMAP_MAX_STATIONS:
        plot_heatmap(df, lags, days)
    else:
        print(f"\nheatmap skipped: MAX_STATIONS={MAX_STATIONS} exceeds "
              f"HEATMAP_MAX_STATIONS={HEATMAP_MAX_STATIONS}")

    ok = df.iloc[:, :-7]
    print(f"\nolder half of window: {(ok.values >= EXPECTED_PER_DAY * 0.9).mean():.0%} of "
          f"station-days at >=90% complete")
    recent = df.iloc[:, -7:]
    print(f"last 7 days        : {(recent.values >= EXPECTED_PER_DAY * 0.9).mean():.0%} of "
          f"station-days at >=90% complete")
    print(f"publication lag    : median {pd.Series(lags).median():.0f}h, "
          f"max {pd.Series(lags).max():.0f}h")


def plot_stats(df: pd.DataFrame, cities: pd.Series, days):
    """Average readings per station per day, one line per city plus the
    all-city mean. Stations that returned nothing count as zero, so the
    average reflects what a consumer of the API actually gets, not just the
    stations that work."""
    per_city_daily = df.groupby(cities).mean()            # city x day
    overall_daily = df.mean(axis=0)                        # day
    n_by_city = cities.value_counts()

    fig, ax = plt.subplots(figsize=(12, 5.2))

    x = range(len(days))
    for city in CITY_BOXES:
        if city in per_city_daily.index:
            ax.plot(x, per_city_daily.loc[city].values, lw=1.4,
                    label=f"{city} (n={n_by_city[city]})")
    ax.plot(x, overall_daily.values, color="black", lw=2.4,
            label=f"All cities (n={len(df)})")
    ax.axhline(EXPECTED_PER_DAY, color="#888", ls="--", lw=1)
    ax.text(0, EXPECTED_PER_DAY + 1.5, f"complete 15-min day = {EXPECTED_PER_DAY}",
            fontsize=8, color="#666")
    ax.set_xticks(list(x))
    ax.set_xticklabels([d.strftime("%d %b") for d in days], rotation=90, fontsize=8)
    ax.set_ylim(0, EXPECTED_PER_DAY * 1.12)
    ax.set_ylabel("mean readings per station")
    ax.legend(fontsize=8, loc="upper right", ncol=2)
    ax.grid(axis="y", alpha=0.3)
    city_list = ", ".join(c for c in CITY_BOXES if c in per_city_daily.index)
    ax.set_title(
        f"Mean {PARAMETER.upper()} readings per station per day, CPCB reference stations in "
        f"{city_list}\n"
        f"OpenAQ /v3/sensors/{{id}}/measurements, {days[0]:%d %b} – {days[-1]:%d %b %Y}",
        loc="left", fontsize=11, fontweight="bold")

    plt.tight_layout()
    out = "openaq_india_coverage_stats.png"
    plt.savefig(out, dpi=140, facecolor="white", bbox_inches="tight")
    print(f"\nwrote {out}")
    plt.close(fig)


def plot_heatmap(df: pd.DataFrame, lags: dict, days):
    """Per-station, per-day heatmap of readings returned."""
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
    plt.close(fig)


if __name__ == "__main__":
    main()
