"""
One-off repair: recompute readings.aqi_value from each reading's measurements.

WHY. Until Nov 2026 aqi_value was computed once, when a timestamp was first
seen, from whichever pollutants had arrived by then -- and never updated when
the rest arrived (audit §1.2). It also had no pollutant rule, so a timestamp
with only SO2 was stored as "Good". The ingests now keep it current
(refresh_reading_aqi); this fixes the readings already stored.

It applies the same rule the ingests now use (scripts/ingest/lib/aqi_rule.py):
the max sub-index when PM2.5 and PM10 are both present, otherwise NULL.

DRY RUN BY DEFAULT. It reads everything and prints how many readings would
change, and how, without writing. Add --apply to write (via set_reading_aqi,
migration 25, which only rewrites rows whose value actually changes).

Reads only source='openaq' readings, one IST day at a time so every query stays
small. Needs migration 25 for --apply.

Usage (from repo root, with .env.local holding the service key):
    /usr/bin/python3 -m scripts.ingest.repair_reading_aqi            # dry run
    /usr/bin/python3 -m scripts.ingest.repair_reading_aqi --apply
    /usr/bin/python3 -m scripts.ingest.repair_reading_aqi --days 3   # just the last 3 days
"""

from __future__ import annotations

import argparse
import sys
from collections import Counter
from datetime import timedelta
from pathlib import Path
from typing import Any, Dict, List

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from scripts.ingest.lib.config import ist_day_bounds_utc, ist_today  # noqa: E402
from scripts.ingest.lib.supabase_client import (  # noqa: E402
    fetch_measurements_for,
    make_client,
    recompute_aqi,
    write_reading_aqi,
)


def readings_for_day(client, day) -> List[Dict[str, Any]]:
    """Every openaq reading recorded on this IST day: id and stored aqi_value."""
    start, end = ist_day_bounds_utc(day)
    rows, offset = [], 0
    while True:
        r = (client.table("readings")
                   .select("id, aqi_value")
                   .eq("source", "openaq")
                   .gte("recorded_at", start.isoformat()).lt("recorded_at", end.isoformat())
                   .order("recorded_at").order("id")
                   .range(offset, offset + 999).execute())
        batch = r.data or []
        rows += batch
        if len(batch) < 1000:
            return rows
        offset += 1000


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--apply", action="store_true", help="write the changes (default: dry run)")
    ap.add_argument("--days", type=int, default=40,
                    help="how many IST days back to repair (default 40, more than raw retention)")
    args = ap.parse_args()

    try:
        from dotenv import load_dotenv
        load_dotenv(Path(__file__).resolve().parents[2] / ".env.local")
    except ImportError:
        pass

    client = make_client()
    today = ist_today()
    print(f"Repairing readings.aqi_value for the last {args.days} IST days "
          f"({'APPLY' if args.apply else 'dry run -- nothing written'})")

    totals: Counter = Counter()
    for back in range(args.days, -1, -1):
        day = today - timedelta(days=back)
        readings = readings_for_day(client, day)
        if not readings:
            continue
        ids = [r["id"] for r in readings]
        new = recompute_aqi(fetch_measurements_for(client, ids), ids)

        day_counts: Counter = Counter()
        changes: Dict[str, Any] = {}
        for r in readings:
            old, now = r["aqi_value"], new[r["id"]]
            if old == now:
                day_counts["unchanged"] += 1
                continue
            changes[r["id"]] = now
            if now is None:
                day_counts["to_empty"] += 1      # the pollutants present cannot carry an AQI
            elif old is None or now > old:
                day_counts["raised"] += 1        # usually PM arrived after the first sight
            else:
                day_counts["lowered"] += 1
        totals.update(day_counts)
        totals["readings"] += len(readings)

        written = write_reading_aqi(client, changes) if (args.apply and changes) else 0
        print(f"  {day}: {len(readings):>6} readings  unchanged {day_counts['unchanged']:>6}  "
              f"raised {day_counts['raised']:>5}  lowered {day_counts['lowered']:>5}  "
              f"to empty {day_counts['to_empty']:>5}"
              + (f"  written {written}" if args.apply else ""))

    print(f"\nTotal: {totals['readings']:,} readings. Unchanged {totals['unchanged']:,}; "
          f"would change {totals['raised'] + totals['lowered'] + totals['to_empty']:,} "
          f"(raised {totals['raised']:,}, lowered {totals['lowered']:,}, "
          f"left empty because PM2.5 and PM10 are not both present {totals['to_empty']:,}).")
    if not args.apply:
        print("Dry run: nothing was written. Re-run with --apply to write.")


if __name__ == "__main__":
    main()
