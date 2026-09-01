"""
Nightly rollup of raw readings + measurements → readings_daily.

Runs once a day (via GitHub Actions). For each (monitor, pollutant, date)
present in the target window, computes distribution stats
(min/mean/max/p10/p50/p90) + timestamps of the daily extremes and upserts
one row into readings_daily.

Idempotent: re-running on the same window overwrites — deliberate so that
late-arriving raw data (e.g. from the S3 daily-backfill for T-3) updates
the rollup on its next nightly run.

The retention job that deletes raw > 90 days old is intentionally SEPARATE
and not enabled until this rollup has been running cleanly for a week
(no accidental data loss if the rollup breaks silently).

Usage (from repo root):
    /opt/homebrew/Caskroom/miniforge/base/bin/python3 -m scripts.ingest.rollup_daily

Env vars required:
    SUPABASE_URL
    SUPABASE_SERVICE_ROLE_KEY

Optional:
    ROLLUP_DATE=2026-08-30    # single date to roll up
    ROLLUP_LOOKBACK_DAYS=5    # re-roll the last N days (default 5, catches S3 backfill for T-3)
    DRY_RUN=1                 # print what would be written, no writes
"""

from __future__ import annotations

import os
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, List

import numpy as np
import pandas as pd

from scripts.ingest.lib.supabase_client import make_client

ROLLUP_TABLE = "readings_daily"
DEFAULT_LOOKBACK_DAYS = 5


def target_dates() -> List[date]:
    """Which UTC dates to roll up on this run."""
    override = os.environ.get("ROLLUP_DATE", "").strip()
    if override:
        return [datetime.strptime(override, "%Y-%m-%d").date()]
    lookback = int(os.environ.get("ROLLUP_LOOKBACK_DAYS", DEFAULT_LOOKBACK_DAYS))
    today = datetime.now(timezone.utc).date()
    # Skip today itself (partial day), roll up yesterday and back.
    return [today - timedelta(days=i) for i in range(1, lookback + 1)]


def fetch_day_measurements(client, day: date) -> pd.DataFrame:
    """All measurements whose parent reading has recorded_at on this UTC day.

    Paginated so >1000 rows are handled. Returns columns:
    monitor_id, pollutant, value, recorded_at (as pandas Timestamp).
    """
    day_start = datetime.combine(day, datetime.min.time(), tzinfo=timezone.utc)
    day_end   = day_start + timedelta(days=1)

    r_rows = []
    offset, page = 0, 1000
    while True:
        r = (client.table("readings")
                    .select("id, monitor_id, recorded_at")
                    .eq("source", "openaq")
                    .gte("recorded_at", day_start.isoformat())
                    .lt("recorded_at", day_end.isoformat())
                    .range(offset, offset + page - 1)
                    .execute())
        r_rows.extend(r.data or [])
        if not r.data or len(r.data) < page:
            break
        offset += page
    if not r_rows:
        return pd.DataFrame()

    readings = pd.DataFrame(r_rows)
    reading_ids = readings["id"].tolist()

    m_rows = []
    for i in range(0, len(reading_ids), 500):
        chunk = reading_ids[i:i + 500]
        m = (client.table("measurements")
                    .select("reading_id, pollutant, value")
                    .in_("reading_id", chunk)
                    .execute())
        m_rows.extend(m.data or [])
    if not m_rows:
        return pd.DataFrame()

    measurements = pd.DataFrame(m_rows)
    joined = measurements.merge(
        readings.rename(columns={"id": "reading_id"}),
        on="reading_id",
    )
    joined["recorded_at"] = pd.to_datetime(joined["recorded_at"], utc=True)
    return joined[["monitor_id", "pollutant", "value", "recorded_at"]]


def compute_rollup(joined: pd.DataFrame, target_date: date) -> List[Dict[str, Any]]:
    """Group by (monitor, pollutant) and compute distribution stats +
    timestamps of the daily min/max."""
    if joined.empty:
        return []
    rows = []
    for (monitor_id, pollutant), g in joined.groupby(["monitor_id", "pollutant"]):
        values = g["value"].values
        min_idx = g["value"].idxmin()
        max_idx = g["value"].idxmax()
        rows.append({
            "monitor_id": monitor_id,
            "pollutant":  pollutant,
            "date":       target_date.isoformat(),
            "count":      int(len(values)),
            "mean":       float(np.mean(values)),
            "min":        float(np.min(values)),
            "min_ts":     g.loc[min_idx, "recorded_at"].isoformat(),
            "max":        float(np.max(values)),
            "max_ts":     g.loc[max_idx, "recorded_at"].isoformat(),
            "p10":        float(np.percentile(values, 10)),
            "p50":        float(np.percentile(values, 50)),
            "p90":        float(np.percentile(values, 90)),
        })
    return rows


def upsert_rollup(client, rows: List[Dict[str, Any]]) -> int:
    """Upsert keyed on (monitor_id, pollutant, date). Overwrites on conflict."""
    if not rows:
        return 0
    result = (client.table(ROLLUP_TABLE)
                     .upsert(rows, on_conflict="monitor_id,pollutant,date")
                     .execute())
    return len(result.data or [])


def main() -> None:
    dry_run = bool(os.environ.get("DRY_RUN"))
    dates = target_dates()
    print(f"Rolling up dates: {[d.isoformat() for d in dates]} (dry_run={dry_run})")

    client = None if dry_run else make_client()
    if dry_run:
        # Still need a client to read; only skip WRITE.
        client = make_client()

    grand_measurements = 0
    grand_rollup_rows  = 0
    for d in dates:
        joined = fetch_day_measurements(client, d)
        grand_measurements += len(joined)
        rows = compute_rollup(joined, d)
        grand_rollup_rows += len(rows)
        print(f"  {d}: {len(joined):>6} measurements → {len(rows):>4} rollup rows")

        if not dry_run and rows:
            upsert_rollup(client, rows)

    print()
    print(f"Total: {grand_measurements} measurements read, "
          f"{grand_rollup_rows} rollup rows {'would be' if dry_run else 'were'} written.")


if __name__ == "__main__":
    main()
