"""
Map our monitors to the XKDR station ids that hold their history.

The forecast fits a seasonal curve per station, which needs that station's
past. Our manifest keys stations by OpenAQ location id; XKDR keys them by its
own `station_id` (site_117 and similar). The only thing the two share is the
station NAME, and they spell names slightly differently.

`station_crosswalk.normalize_station_name` already handles that spelling
problem conservatively -- it folds whitespace, "New Delhi" vs "Delhi" and a
redundant state suffix, and nothing else, because a false pair here silently
attaches one station's history to another.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any, Dict, Optional

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from scripts.ingest.historical.station_crosswalk import (  # noqa: E402
    XKDR_GLOB, normalize_station_name,
)


def xkdr_name_to_id() -> Dict[str, str]:
    """Normalized XKDR station name -> station_id.

    Where a name maps to several ids (a station re-registered on XKDR's side),
    keeps the one with the most readings: that is the series worth fitting on.
    """
    import duckdb

    con = duckdb.connect()
    rows = con.sql(f"""
        SELECT station_name, station_id, count(*) AS n
        FROM read_parquet('{XKDR_GLOB}', hive_partitioning=true,
                          hive_types={{'year':INTEGER,'month':INTEGER}})
        WHERE parameter_name = 'PM2.5' AND station_name IS NOT NULL
        GROUP BY 1, 2
    """).df()

    best: Dict[str, tuple] = {}
    for r in rows.itertuples():
        key = normalize_station_name(r.station_name)
        if key not in best or r.n > best[key][1]:
            best[key] = (r.station_id, r.n)
    return {k: v[0] for k, v in best.items()}


def build_monitor_to_xkdr(manifest: Dict[str, Any]) -> Dict[str, Optional[str]]:
    """monitor_id -> XKDR station_id, or None where no history exists."""
    lookup = xkdr_name_to_id()
    out: Dict[str, Optional[str]] = {}
    for st in manifest["stations"]:
        out[st["monitor_id"]] = lookup.get(normalize_station_name(st["name"]))
    return out
