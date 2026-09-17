"""
Aggregate the local OpenAQ archive to HOURLY means, for stations that have an
XKDR counterpart.

Why hourly: XKDR publishes one value per station/pollutant/hour, while the
OpenAQ archive carries CPCB's raw quarter-hourly feed. The hour is therefore
the finest granularity at which the two datasets can be compared at all.

The output keeps `n_sub` -- how many sub-hourly readings went into each hourly
mean. That column is the whole point. Spot-checking ITO for Apr-Aug 2025 showed
OpenAQ's hourly mean equals XKDR's value *exactly* whenever all four
quarter-hourly readings are present, and differs only when OpenAQ is missing
some of them. Without n_sub the comparison shows unexplained noise; with it,
the noise resolves into "one source had less data that hour".

Rows are keyed by the NORMALIZED station name rather than location_id, because
OpenAQ re-registers the same physical station under new ids over time (R K Puram
is 17, 5639 and 7044). All ids for a name are pooled; `n_ids` records how many
contributed to an hour, which is >1 only where two registrations overlap.

Output: data/openaq-hourly.parquet (written via DuckDB -- pyarrow isn't
installed in either of this machine's Pythons, but DuckDB writes parquet
natively).

Usage:
    python3 scripts/ingest/historical/build_hourly_cache.py --rebuild
"""

from __future__ import annotations

import argparse
import glob
import sys
import time
from collections import defaultdict
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
from typing import Any, Dict, List, Optional

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from scripts.ingest.lib.config import PROJECT_ROOT, TARGET_POLLUTANTS  # noqa: E402
from scripts.ingest.historical.build_daily_cache import PLAUSIBLE_MAX  # noqa: E402
from scripts.ingest.historical.station_crosswalk import (  # noqa: E402
    build_crosswalk,
    normalize_station_name,
)

ARCHIVE_DIR = PROJECT_ROOT / "data" / "openaq-archive"
CACHE_PATH  = PROJECT_ROOT / "data" / "openaq-hourly.parquet"


def _aggregate_one(args) -> Optional[pd.DataFrame]:
    """Collapse one station-day CSV to one row per pollutant per hour."""
    path_str, station_key = args
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

    # Same two quality filters as the daily cache: negatives and physically
    # impossible highs are dropped, not clamped.
    df = df[df["value"] >= 0]
    ceiling = df["pollutant"].map(PLAUSIBLE_MAX)
    df = df[df["value"] <= ceiling]
    if df.empty:
        return None

    # Timestamps are already station-local ("2025-04-01T00:45:00+05:30"), and the
    # lag scan in the comparison notebook confirms XKDR is on the same local
    # clock. So the hour is just the leading "YYYY-MM-DDTHH" -- no tz maths.
    # Named hour_key, not hour: "hour" is a reserved word in DuckDB and would
    # need quoting in every query the comparison notebook runs.
    df["hour_key"] = df["datetime"].str.slice(0, 13)

    out = (
        df.groupby(["hour_key", "pollutant"], as_index=False)
          .agg(value_sum=("value", "sum"), n_sub=("value", "size"))
    )
    out["station_key"]  = station_key
    out["location_id"]  = df["location_id"].iloc[0]
    return out


def build_cache(workers: int = 8, verbose: bool = True) -> Path:
    import duckdb

    con = duckdb.connect()
    crosswalk = build_crosswalk(con)

    # location_id -> normalized station key, for every matched station.
    id_to_key: Dict[int, str] = {}
    for p in crosswalk["pairs"]:
        for i in p["openaq_ids"]:
            id_to_key[i] = p["key"]
    if verbose:
        print(f"{len(crosswalk['pairs'])} matched stations, "
              f"{len(id_to_key)} OpenAQ location_ids")

    tasks = []
    for loc_id, key in id_to_key.items():
        for f in glob.glob(str(ARCHIVE_DIR / f"locationid={loc_id}" / "*" / "*" / "*.csv.gz")):
            tasks.append((f, key))
    if not tasks:
        raise SystemExit(f"No archive files found under {ARCHIVE_DIR}.")
    if verbose:
        print(f"Aggregating {len(tasks):,} files to hourly with {workers} workers ...")

    t0 = time.time()
    frames: List[pd.DataFrame] = []
    with ProcessPoolExecutor(max_workers=workers) as ex:
        for i, res in enumerate(ex.map(_aggregate_one, tasks, chunksize=200), start=1):
            if res is not None:
                frames.append(res)
            if verbose and i % 20000 == 0:
                print(f"  ... {i:,}/{len(tasks):,} ({time.time() - t0:.0f}s)", flush=True)

    hourly = pd.concat(frames, ignore_index=True)
    if verbose:
        print(f"  {len(hourly):,} rows before pooling re-registered ids "
              f"({time.time() - t0:.0f}s)", flush=True)

    # Pool the several location_ids that share a station name. Summing the
    # value-sums and counts (rather than averaging the averages) keeps the
    # result a true mean over all readings in the hour.
    pooled = (
        hourly.groupby(["station_key", "hour_key", "pollutant"], as_index=False)
              .agg(value_sum=("value_sum", "sum"),
                   n_sub=("n_sub", "sum"),
                   n_ids=("location_id", "nunique"))
    )
    pooled["mean"] = pooled["value_sum"] / pooled["n_sub"]
    pooled = pooled[["station_key", "pollutant", "hour_key", "mean", "n_sub", "n_ids"]]

    CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    con.execute(f"COPY (SELECT * FROM pooled) TO '{CACHE_PATH}' (FORMAT PARQUET)")
    if verbose:
        print(f"Wrote {len(pooled):,} station-hours to {CACHE_PATH} "
              f"({CACHE_PATH.stat().st_size / 1e6:.1f} MB) in {time.time() - t0:.0f}s")
    return CACHE_PATH


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--rebuild", action="store_true")
    ap.add_argument("--workers", type=int, default=8)
    a = ap.parse_args()
    if CACHE_PATH.exists() and not a.rebuild:
        print(f"{CACHE_PATH} already exists; pass --rebuild to regenerate.")
    else:
        build_cache(workers=a.workers)
