"""
Aggregate the local OpenAQ archive into a compact station-day cache.

The raw archive (data/openaq-archive/) is 140k small gzipped CSVs -- about
40 million measurement rows. Re-reading all of that every time a notebook
cell runs is wasteful, so this module boils it down once into one table of
per-station, per-pollutant, per-day aggregates and caches it on disk.

Output: data/openaq-archive-daily.csv.gz, roughly half a million rows.

  location_id  OpenAQ station id
  city         Delhi NCR / Mumbai / Bangalore (from target_stations.json)
  date         LOCAL (IST) calendar date -- see note below
  pollutant    pm25 / pm10 / no2 / so2
  mean/min/max per-day statistics over that station's readings
  count        how many raw readings went into the day

Why local dates rather than UTC: the ingest pipeline stores UTC because it
needs a globally-orderable instant, but "what was PM2.5 like on the 3rd of
November" is a question about the Indian calendar day. Bucketing by UTC
would smear each Indian day across two, shifting the whole diurnal cycle by
5h30m. OpenAQ writes these timestamps already in station-local time, so the
local date is just the leading YYYY-MM-DD of the string -- no timezone
conversion needed, which also makes this a lot faster over 40M rows.

Usage:
    from scripts.ingest.historical.build_daily_cache import load_daily
    df = load_daily()            # builds on first call, then reads cache

    python3 scripts/ingest/historical/build_daily_cache.py --rebuild
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
from typing import Dict, List, Optional

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from scripts.ingest.lib.config import (  # noqa: E402
    PROJECT_ROOT,
    TARGET_POLLUTANTS,
    TARGET_STATIONS_PATH,
)

ARCHIVE_DIR = PROJECT_ROOT / "data" / "openaq-archive"
CACHE_PATH  = PROJECT_ROOT / "data" / "openaq-archive-daily.csv.gz"

# Everything in the Indian archive is reported in µg/m³. We assert rather
# than convert: if OpenAQ ever starts mixing units, silently averaging ppb
# with µg/m³ would produce plausible-looking nonsense, so we'd rather know.
EXPECTED_UNITS = {"µg/m³"}

# Physical plausibility ceilings, µg/m³. The archive contains occasional sentinel
# / instrument-fault values -- we found single readings of 7.7e15 µg/m³, and one
# of those in a day is enough to drag that station-day's mean to 8.8e13 and, from
# there, poison the city average and every chart built on it.
#
# These are deliberately generous: real ambient PM2.5 in Delhi's worst winter
# smog peaks around 1,000-1,500 µg/m³, so a 2,000 ceiling discards nothing real.
# PM10 is allowed more headroom because dust storms genuinely spike it. The point
# is to catch garbage, not to trim real extremes -- 99.9% of station-days have a
# max under 3,844.
PLAUSIBLE_MAX = {"pm25": 2000.0, "pm10": 5000.0, "no2": 1000.0, "so2": 1000.0}


def station_city_map() -> Dict[int, str]:
    """openaq_id -> city, from the bootstrap manifest."""
    with TARGET_STATIONS_PATH.open("r", encoding="utf-8") as f:
        stations = json.load(f)["stations"]
    return {s["openaq_id"]: s["city"] for s in stations}


def _aggregate_one(path_str: str) -> Optional[pd.DataFrame]:
    """Read one station-day CSV and collapse it to one row per pollutant."""
    try:
        df = pd.read_csv(path_str, compression="gzip")
    except Exception:
        return None
    if df.empty:
        return None

    df["pollutant"] = df["parameter"].str.lower().replace({"pm2.5": "pm25"})
    df = df[df["pollutant"].isin(TARGET_POLLUTANTS)]
    if df.empty:
        return None

    # Guard against unit drift (see EXPECTED_UNITS).
    bad_units = set(df["units"].dropna().unique()) - EXPECTED_UNITS
    if bad_units:
        df = df[df["units"].isin(EXPECTED_UNITS)]
        if df.empty:
            return None

    # Negative concentrations are sensors drifting below zero, not real air.
    # Same policy as the live ingest: drop, don't clamp.
    df = df[df["value"] >= 0]
    if df.empty:
        return None

    # Drop physically impossible highs (see PLAUSIBLE_MAX). Dropping rather than
    # clamping, for the same reason as negatives: a clamped 2000 would look like
    # a real extreme event in the data and get interpreted as one.
    ceiling = df["pollutant"].map(PLAUSIBLE_MAX)
    n_implausible = int((df["value"] > ceiling).sum())
    df = df[df["value"] <= ceiling]
    if df.empty:
        return None

    # Local calendar date = leading YYYY-MM-DD of an already-local timestamp.
    df["date"] = df["datetime"].str.slice(0, 10)

    out = (
        df.groupby(["location_id", "date", "pollutant"], as_index=False)
          .agg(mean=("value", "mean"),
               min=("value", "min"),
               max=("value", "max"),
               count=("value", "size"))
    )
    # Stash the discard count on the frame so build_cache can total it up and
    # report how much was thrown away, rather than filtering silently.
    out.attrs["n_implausible"] = n_implausible
    return out


def build_cache(workers: int = 8, verbose: bool = True) -> pd.DataFrame:
    """Walk the whole archive, aggregate every file, write the cache."""
    files = sorted(str(p) for p in ARCHIVE_DIR.rglob("*.csv.gz"))
    if not files:
        raise SystemExit(
            f"No archive files under {ARCHIVE_DIR}. "
            f"Run scripts/ingest/historical/download_archive.py first."
        )
    if verbose:
        print(f"Aggregating {len(files):,} archive files with {workers} workers ...")

    t0 = time.time()
    frames: List[pd.DataFrame] = []
    # chunksize batches files per worker so we're not paying IPC per tiny file.
    with ProcessPoolExecutor(max_workers=workers) as ex:
        n_implausible = 0
        for i, res in enumerate(ex.map(_aggregate_one, files, chunksize=200), start=1):
            if res is not None:
                frames.append(res)
                n_implausible += res.attrs.get("n_implausible", 0)
            if verbose and i % 10000 == 0:
                # flush: stdout is block-buffered when redirected to a file, so
                # without this the progress lines only appear at the very end.
                print(f"  ... {i:,}/{len(files):,} files ({time.time() - t0:.0f}s)",
                      flush=True)
    if verbose and n_implausible:
        print(f"  dropped {n_implausible:,} readings above the plausibility ceiling")

    daily = pd.concat(frames, ignore_index=True)

    # Attach city. Stations not in the manifest shouldn't exist here, but if
    # one does we label it rather than dropping it silently.
    cities = station_city_map()
    daily["city"] = daily["location_id"].map(cities).fillna("unknown")

    daily = daily[["location_id", "city", "date", "pollutant",
                   "mean", "min", "max", "count"]]
    daily = daily.sort_values(["city", "location_id", "pollutant", "date"])

    CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    daily.to_csv(CACHE_PATH, index=False, compression="gzip")
    if verbose:
        print(f"Wrote {len(daily):,} station-days to {CACHE_PATH} "
              f"({CACHE_PATH.stat().st_size / 1e6:.1f} MB) in {time.time() - t0:.0f}s")
    return daily


def load_daily(rebuild: bool = False, workers: int = 8, verbose: bool = True) -> pd.DataFrame:
    """Load the cache, building it first if it's missing or a rebuild is forced."""
    if CACHE_PATH.exists() and not rebuild:
        df = pd.read_csv(CACHE_PATH)
        if verbose:
            print(f"Loaded cache: {len(df):,} station-days from {CACHE_PATH.name}")
    else:
        df = build_cache(workers=workers, verbose=verbose)

    # Parse once here so every caller gets real datetimes, not strings.
    df["date"] = pd.to_datetime(df["date"])
    df["year"] = df["date"].dt.year
    # day-of-year, used to overlay years on a common Jan-Dec axis
    df["doy"] = df["date"].dt.dayofyear
    return df


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--rebuild", action="store_true", help="ignore any existing cache")
    ap.add_argument("--workers", type=int, default=8)
    args = ap.parse_args()
    load_daily(rebuild=args.rebuild, workers=args.workers)
