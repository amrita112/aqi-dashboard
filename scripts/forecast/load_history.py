"""
Load historical daily aggregates from the XKDR export into readings_daily.

Why this exists: the monthly refit fits climatology from years of history, and
until now it read a gitignored local parquet directory. That works on a laptop
and fails on a CI runner, which is why the refit workflow currently refuses to
run. Putting the history in Supabase makes the refit a normal job.

Size: 843k rows for the 135 stations we can map to XKDR history, roughly 84 MB
in Postgres. That fits the budget in docs/storage-and-forecast-design.md, and
the retention job cannot touch it -- prune_raw deletes raw `readings`, never
readings_daily.

Rows are marked source='xkdr'. That matters because XKDR is HOURLY while our
own ingest is 15-minute, so a complete historical day has count ~24 and a
complete live day ~96. The daily means are comparable; the counts are not.

Usage (from repo root):
    python3 -m scripts.forecast.load_history --dry-run
    python3 -m scripts.forecast.load_history
    python3 -m scripts.forecast.load_history --since 2019-01-01
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict, List

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from scripts.forecast.baselines import XKDR_GLOB  # noqa: E402
from scripts.forecast.station_map import build_monitor_to_xkdr  # noqa: E402
from scripts.ingest.lib.config import TARGET_STATIONS_PATH  # noqa: E402
from scripts.ingest.lib.supabase_client import make_client  # noqa: E402

# Matches the cap in rollup_daily, so the two populations store ties the same way.
MAX_TIED_TIMESTAMPS = 24
CHUNK = 500


def extremes_for(since: str, id_list: str) -> pd.DataFrame:
    """Timestamps of each day's min and max, including ties."""
    import duckdb

    con = duckdb.connect()
    con.execute(
        f"CREATE VIEW m AS SELECT * FROM read_parquet('{XKDR_GLOB}', "
        f"hive_partitioning=true, hive_types={{'year':INTEGER,'month':INTEGER}})"
    )
    return con.sql(f"""
        WITH base AS (
            SELECT station_id AS station,
                   CASE parameter_name WHEN 'PM2.5' THEN 'pm25' WHEN 'PM10' THEN 'pm10'
                        WHEN 'NO2' THEN 'no2' WHEN 'SO2' THEN 'so2' END AS pollutant,
                   CAST(collected_at AS DATE) AS d,
                   collected_at AS ts, value
            FROM m
            WHERE parameter_name IN ('PM2.5','PM10','NO2','SO2')
              AND station_id IN ({id_list})
              -- Deliberately NOT filtered by city_name. station_id already
              -- pins the station, and the city filter actively lost 25 of 135
              -- stations: XKDR labels Gurugram, Ghaziabad, Noida, Howrah, Navi
              -- Mumbai and Thane as their own cities, while our bounding boxes
              -- correctly place them inside Delhi NCR, Kolkata and Mumbai.
              AND value BETWEEN 0 AND 2000
              AND collected_at >= '{since}'
        ), ranked AS (
            SELECT *, min(value) OVER w AS dmin, max(value) OVER w AS dmax
            FROM base WINDOW w AS (PARTITION BY station, pollutant, d)
        )
        SELECT station, pollutant, d,
               list_sort(list(ts) FILTER (WHERE value = dmin)) AS min_ts_all,
               list_sort(list(ts) FILTER (WHERE value = dmax)) AS max_ts_all,
               count(*) FILTER (WHERE value = dmin) AS min_tie_count,
               count(*) FILTER (WHERE value = dmax) AS max_tie_count
        FROM ranked
        GROUP BY 1, 2, 3
    """).df()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--since", default="2009-01-01")
    args = ap.parse_args()

    manifest = json.loads(TARGET_STATIONS_PATH.read_text())

    # ONE XKDR station can back SEVERAL of our monitors. OpenAQ re-registers a
    # station under a new location id every so often and our manifest keeps
    # both, so both match the same XKDR name. An xkdr_id -> monitor_id dict
    # silently drops all but the last, which cost 25 monitors their entire
    # history on the first run of this script.
    #
    # They are the same physical place, so giving each monitor the same
    # historical curve is correct rather than merely convenient: whichever
    # registration is currently live gets a usable climatology, and the dormant
    # one does too if it wakes up.
    monitors_of_station: Dict[str, List[str]] = {}
    for mon_id, xkdr_id in build_monitor_to_xkdr(manifest).items():
        if xkdr_id:
            monitors_of_station.setdefault(xkdr_id, []).append(mon_id)
    n_monitors = sum(len(v) for v in monitors_of_station.values())
    shared = sum(1 for v in monitors_of_station.values() if len(v) > 1)
    print(f"{len(monitors_of_station)} XKDR stations back {n_monitors} of our monitors "
          f"({shared} stations back more than one)")

    id_list = ", ".join(f"'{s}'" for s in monitors_of_station)
    print("Aggregating history (this reads the whole export) ...")
    ext = extremes_for(args.since, id_list)
    print(f"  {len(ext):,} station-pollutant-days")

    import duckdb
    con = duckdb.connect()
    con.execute(
        f"CREATE VIEW m AS SELECT * FROM read_parquet('{XKDR_GLOB}', "
        f"hive_partitioning=true, hive_types={{'year':INTEGER,'month':INTEGER}})"
    )
    stats = con.sql(f"""
        SELECT station_id AS station,
               CASE parameter_name WHEN 'PM2.5' THEN 'pm25' WHEN 'PM10' THEN 'pm10'
                    WHEN 'NO2' THEN 'no2' WHEN 'SO2' THEN 'so2' END AS pollutant,
               CAST(collected_at AS DATE) AS d,
               count(*) AS n, avg(value) AS mean,
               min(value) AS vmin, max(value) AS vmax,
               quantile_cont(value, 0.10) AS p10,
               quantile_cont(value, 0.50) AS p50,
               quantile_cont(value, 0.90) AS p90
        FROM m
        WHERE parameter_name IN ('PM2.5','PM10','NO2','SO2')
          AND station_id IN ({id_list})
          -- No city_name filter; see the note in extremes_for().
          AND value BETWEEN 0 AND 2000
          AND collected_at >= '{args.since}'
        GROUP BY 1, 2, 3
    """).df()

    df = stats.merge(ext, on=["station", "pollutant", "d"], how="inner")
    # Explode one row per (station, day) into one per MONITOR backed by that
    # station, so shared registrations each get the history.
    df["monitor_id"] = df.station.map(monitors_of_station)
    df = df.explode("monitor_id").dropna(subset=["monitor_id"])
    print(f"  {len(df):,} rows after joining extremes and mapping monitors")
    print(f"  {df.monitor_id.nunique()} monitors, "
          f"{df.d.min()} to {df.d.max()}")
    print(f"  estimated Postgres size: {len(df) * 100 / 1e6:.0f} MB")

    if args.dry_run:
        print("\nDry run — nothing written.")
        return

    client = make_client()
    rows: List[Dict[str, Any]] = []
    for r in df.itertuples():
        rows.append({
            "monitor_id": r.monitor_id, "pollutant": r.pollutant,
            "date": str(r.d), "count": int(r.n), "mean": float(r.mean),
            "min": float(r.vmin), "max": float(r.vmax),
            "min_ts": pd.Timestamp(r.min_ts_all[0]).isoformat(),
            "max_ts": pd.Timestamp(r.max_ts_all[0]).isoformat(),
            "min_ts_all": [pd.Timestamp(t).isoformat()
                           for t in r.min_ts_all[:MAX_TIED_TIMESTAMPS]],
            "max_ts_all": [pd.Timestamp(t).isoformat()
                           for t in r.max_ts_all[:MAX_TIED_TIMESTAMPS]],
            "min_tie_count": int(r.min_tie_count),
            "max_tie_count": int(r.max_tie_count),
            "is_flat": bool(r.vmin == r.vmax),
            "p10": float(r.p10), "p50": float(r.p50), "p90": float(r.p90),
            "source": "xkdr",
        })

    written = 0
    for i in range(0, len(rows), CHUNK):
        chunk = rows[i:i + CHUNK]
        (client.table("readings_daily")
               .upsert(chunk, on_conflict="monitor_id,pollutant,date")
               .execute())
        written += len(chunk)
        if written % 25000 < CHUNK:
            print(f"  ... {written:,}/{len(rows):,}")
    print(f"\nreadings_daily: {written:,} historical rows upserted")


if __name__ == "__main__":
    main()
