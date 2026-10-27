"""
Fill the gap in the forecast history from the local OpenAQ S3 archive.

The monthly refit learns from two daily histories: XKDR (2009 to 1 Sep 2025,
a file in Supabase Storage) and our own rollups in readings_daily (from
17 Aug 2026). Nothing covered the year in between -- including the whole
2025-26 winter. The OpenAQ archive does, so this boils it down into the same
daily format and writes a second history file next to the XKDR one.

Why a separate file rather than appending to the XKDR one: the XKDR file is a
checked, byte-identical copy of the database rows it replaces. Keeping it
untouched keeps that check valid, and keeps each source's provenance clear.

How a day is built, matching the XKDR rows so the two stack cleanly:
  - one row per (monitor, pollutant, IST calendar day); OpenAQ's archive
    timestamps are already station-local, so the day is the leading date
  - units converted exactly as the live ingest does (convert_to_canonical):
    the archive reports NO2 and SO2 in ppb, so skipping this would either
    drop every gas reading or treat ppb as µg/m³. A unit it cannot convert
    is dropped and counted.
  - values kept only if 0 <= value <= 2000 µg/m³ after conversion, the same
    filter XKDR's rows were built with; anything else is a sentinel or fault
  - every sensor at a location is pooled. OpenAQ re-sensored stations, so the
    old and new sensor ids hold different stretches of the same monitor.

Usage (from repo root; needs the archive from download_archive.py):
    python3 -m scripts.forecast.archive_history
    python3 -m scripts.forecast.archive_history --since 2025-09-02 --until 2026-08-16
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
from typing import List, Optional

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from scripts.ingest.lib.aqi_utils import convert_to_canonical  # noqa: E402
from scripts.ingest.lib.config import PROJECT_ROOT, TARGET_STATIONS_PATH  # noqa: E402

ARCHIVE_DIR = PROJECT_ROOT / "data" / "openaq-archive"
OUT_PATH = PROJECT_ROOT / "data" / "openaq_archive_daily_history.parquet"

# The gap this fills: the day after XKDR's last full day, to the day before
# our own rollups start (17 Aug 2026 is a partial first day, so it is left to
# readings_daily alone rather than counted twice).
DEFAULT_SINCE = "2025-09-02"
DEFAULT_UNTIL = "2026-08-16"

POLLUTANT_NAMES = {"pm25": "pm25", "pm2.5": "pm25", "pm10": "pm10",
                   "no2": "no2", "so2": "so2"}
VALUE_MIN, VALUE_MAX = 0.0, 2000.0


def _unit_factor(pollutant: str, units: str) -> float:
    """Multiplier into canonical units, or NaN if the unit is not convertible.

    Every conversion in convert_to_canonical is a plain scaling, so converting
    1.0 gives the factor, and each (pollutant, unit) pair is looked up once per
    file instead of once per reading.
    """
    try:
        f = convert_to_canonical(pollutant, 1.0, units)
    except Exception:
        f = None
    return float("nan") if f is None else float(f)


def _aggregate_file(path_str: str) -> Optional[pd.DataFrame]:
    """One station-day file -> one row per pollutant, plus what was dropped."""
    try:
        df = pd.read_csv(path_str, compression="gzip",
                         usecols=["location_id", "datetime", "parameter", "units", "value"])
    except Exception:
        return None
    df["pollutant"] = df["parameter"].str.lower().map(POLLUTANT_NAMES)
    df = df[df["pollutant"].notna()]
    if df.empty:
        return None
    pairs = df[["pollutant", "units"]].drop_duplicates()
    factor = {(p, u): _unit_factor(p, u) for p, u in zip(pairs.pollutant, pairs.units)}
    df["value"] = df["value"] * [factor[k] for k in zip(df.pollutant, df.units)]
    n_units = int(df["value"].isna().sum())
    df = df[df["value"].notna()]
    in_range = df["value"].between(VALUE_MIN, VALUE_MAX)
    n_range = int((~in_range).sum())
    df = df[in_range]
    if df.empty:
        return None
    df["date"] = df["datetime"].str.slice(0, 10)
    out = (df.groupby(["location_id", "date", "pollutant"], as_index=False)
             .agg(count=("value", "size"), mean=("value", "mean"),
                  min=("value", "min"), max=("value", "max")))
    out.attrs["dropped_units"] = n_units
    out.attrs["dropped_range"] = n_range
    return out


def build(since: str, until: str, workers: int = 8) -> pd.DataFrame:
    stations = json.loads(TARGET_STATIONS_PATH.read_text())["stations"]
    monitor_of = {int(s["openaq_id"]): s["monitor_id"] for s in stations}

    # File names end in -YYYYMMDD.csv.gz, so the date filter needs no reading.
    lo, hi = since.replace("-", ""), until.replace("-", "")
    files = []
    for loc_id in monitor_of:
        for p in (ARCHIVE_DIR / f"locationid={loc_id}").rglob("*.csv.gz"):
            day = p.name.rsplit("-", 1)[-1][:8]
            if lo <= day <= hi:
                files.append(str(p))
    print(f"Aggregating {len(files):,} day-files for {len(monitor_of)} stations, "
          f"{since} -> {until} ...")

    t0 = time.time()
    frames: List[pd.DataFrame] = []
    dropped_units = dropped_range = 0
    with ProcessPoolExecutor(max_workers=workers) as ex:
        for res in ex.map(_aggregate_file, sorted(files), chunksize=200):
            if res is not None:
                frames.append(res)
                dropped_units += res.attrs["dropped_units"]
                dropped_range += res.attrs["dropped_range"]
    daily = pd.concat(frames, ignore_index=True)

    # A file holds one local day, but a reading stamped just after midnight
    # can land in the neighbouring file -- re-pool so each day is one row.
    daily["total"] = daily["mean"] * daily["count"]
    daily = (daily.groupby(["location_id", "date", "pollutant"], as_index=False)
                  .agg(count=("count", "sum"), total=("total", "sum"),
                       min=("min", "min"), max=("max", "max")))
    daily["mean"] = daily["total"] / daily["count"]
    daily = daily[(daily["date"] >= since) & (daily["date"] <= until)]

    daily["monitor_id"] = daily["location_id"].map(monitor_of)
    daily["source"] = "openaq_archive"
    daily = (daily[["monitor_id", "pollutant", "date", "count", "mean", "min", "max", "source"]]
             .sort_values(["date", "monitor_id", "pollutant"]).reset_index(drop=True))

    dupes = daily.duplicated(["monitor_id", "pollutant", "date"]).sum()
    if dupes:
        raise SystemExit(f"{dupes} duplicate (monitor, pollutant, date) rows -- not writing")
    print(f"  dropped {dropped_range:,} readings outside 0-2000 and "
          f"{dropped_units:,} in units that could not be converted")
    print(f"  {len(daily):,} station-days in {time.time() - t0:.0f}s")
    return daily


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--since", default=DEFAULT_SINCE)
    ap.add_argument("--until", default=DEFAULT_UNTIL)
    ap.add_argument("--workers", type=int, default=8)
    args = ap.parse_args()

    daily = build(args.since, args.until, args.workers)
    daily.to_parquet(OUT_PATH, compression="zstd", index=False)
    print(f"Wrote {OUT_PATH} ({OUT_PATH.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
