"""
Export the XKDR history in readings_daily to one Parquet file, so it can live
in Supabase Storage instead of the database.

Why this exists: on 26 Oct 2026 the database was 1.25 GB against the free
plan's 500 MB, and these ~991k rows were about 310 MB of it (load_history.py
had estimated 84 MB). The only thing that reads them is the monthly refit,
which needs years of history. Storage has its own free quota, separate from
the database's, and a Parquet file of the same rows is a few tens of MB.

EVERY COLUMN IS KEPT, not just the four the refit reads. That makes the file a
complete copy: if the history ever has to go back into the database, this file
is enough, with no need to re-run load_history.py from the raw XKDR export.

Read-only against the database. Writes one local file, which is uploaded to
the `forecast-history` bucket by hand (Supabase dashboard -> Storage).

Usage (from repo root):
    python3 -m scripts.forecast.export_history
    python3 -m scripts.forecast.export_history --out somewhere/else.parquet
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from scripts.forecast.baselines import PROJECT_ROOT, XKDR_HISTORY_OBJECT  # noqa: E402
from scripts.ingest.lib.supabase_client import make_client  # noqa: E402

DEFAULT_OUT = PROJECT_ROOT / "data" / XKDR_HISTORY_OBJECT
PAGE = 1000


def fetch_year(client, year: int) -> list:
    """All XKDR rows for one calendar year.

    Paged one year at a time for the same reason as _fetch_readings_daily in
    baselines.py: a single offset walk over a million rows gets slower the
    deeper it goes, until the query times out. The ORDER BY is the table's
    primary key, so pages neither overlap nor skip rows.
    """
    rows, offset = [], 0
    while True:
        batch = (client.table("readings_daily").select("*")
                       .eq("source", "xkdr")
                       .gte("date", f"{year}-01-01").lte("date", f"{year}-12-31")
                       .order("date").order("monitor_id").order("pollutant")
                       .range(offset, offset + PAGE - 1).execute().data or [])
        rows += batch
        if len(batch) < PAGE:
            return rows
        offset += PAGE


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = ap.parse_args()

    client = make_client()

    # How many rows there should be, counted by the database itself, so the
    # file can be checked against it rather than against our own paging.
    expected = (client.table("readings_daily").select("monitor_id", count="exact")
                      .eq("source", "xkdr").limit(1).execute().count)
    span = (client.table("readings_daily").select("date").eq("source", "xkdr")
                  .order("date").limit(1).execute().data)
    first_year = int(span[0]["date"][:4])
    last = (client.table("readings_daily").select("date").eq("source", "xkdr")
                  .order("date", desc=True).limit(1).execute().data)
    last_year = int(last[0]["date"][:4])
    print(f"XKDR rows in readings_daily: {expected:,} ({first_year}-{last_year})")

    rows = []
    for year in range(first_year, last_year + 1):
        got = fetch_year(client, year)
        rows += got
        print(f"  {year}: {len(got):,} rows")

    df = pd.DataFrame(rows)
    dupes = df.duplicated(["monitor_id", "pollutant", "date"]).sum()
    if len(df) != expected or dupes:
        raise SystemExit(f"Refusing to write: got {len(df):,} rows ({dupes} duplicated) "
                         f"but the database holds {expected:,}.")

    args.out.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(args.out, index=False, compression="zstd")
    print(f"\nWrote {len(df):,} rows to {args.out} "
          f"({args.out.stat().st_size / 1e6:.1f} MB). Row count matches the database.")
    print("Next: upload it to the `forecast-history` bucket in Supabase Storage.")


if __name__ == "__main__":
    main()
