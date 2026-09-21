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
import time
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
    # GitHub Actions passes unset workflow inputs as "" not unset, so guard
    # against int("") crashing when the user leaves the input blank.
    lookback_raw = os.environ.get("ROLLUP_LOOKBACK_DAYS", "").strip()
    lookback = int(lookback_raw) if lookback_raw else DEFAULT_LOOKBACK_DAYS
    today = datetime.now(timezone.utc).date()
    # Skip today itself (partial day), roll up yesterday and back.
    return [today - timedelta(days=i) for i in range(1, lookback + 1)]


# PostgREST's default response cap. Both the reading and measurement queries
# page against this rather than assuming a request returns everything.
PAGE = 1000

# Supabase sits behind Cloudflare, which intermittently returns a 502 HTML page
# instead of JSON. One of those killed a 35-day re-roll partway through on
# 2026-09-21, losing the remaining days. The failure is transient and a retry
# clears it, so every read goes through this rather than calling .execute()
# directly.
QUERY_RETRIES = 4


def _execute(build_query, what: str):
    """Run a PostgREST query, retrying transient gateway failures.

    `build_query` is a zero-arg callable returning a fresh query object --
    fresh because a PostgREST builder cannot be re-executed once it has failed.
    """
    delay = 2.0
    for attempt in range(QUERY_RETRIES):
        try:
            return build_query().execute()
        except Exception as e:
            transient = any(t in str(e) for t in ("502", "503", "504", "timeout",
                                                  "Bad Gateway", "JSON could not be generated"))
            if attempt == QUERY_RETRIES - 1 or not transient:
                raise
            print(f"  {what}: {type(e).__name__} (attempt {attempt + 1}/"
                  f"{QUERY_RETRIES}); retrying in {delay:.0f}s")
            time.sleep(delay)
            delay *= 2

# Reading ids per measurements query. Kept well under PAGE / measurements-per-
# reading so most chunks resolve in a single request, but correctness no longer
# depends on that -- the loop below pages until the chunk is exhausted.
MEASUREMENT_CHUNK = 200


def fetch_day_measurements(client, day: date) -> pd.DataFrame:
    """All measurements whose parent reading has recorded_at on this UTC day.

    Paginated so >1000 rows are handled. Returns columns:
    monitor_id, pollutant, value, recorded_at (as pandas Timestamp).
    """
    day_start = datetime.combine(day, datetime.min.time(), tzinfo=timezone.utc)
    day_end   = day_start + timedelta(days=1)

    r_rows = []
    offset, page = 0, PAGE
    while True:
        off = offset
        r = _execute(
            lambda: (client.table("readings")
                           .select("id, monitor_id, recorded_at")
                           .eq("source", "openaq")
                           .gte("recorded_at", day_start.isoformat())
                           .lt("recorded_at", day_end.isoformat())
                           .range(off, off + page - 1)),
            f"readings {day} offset {off}")
        r_rows.extend(r.data or [])
        if not r.data or len(r.data) < page:
            break
        offset += page
    if not r_rows:
        return pd.DataFrame()

    readings = pd.DataFrame(r_rows)
    reading_ids = readings["id"].tolist()

    # PostgREST caps a response at 1000 rows by default, and each reading
    # carries 3-4 measurements. The original code asked for 500 reading_ids at
    # a time WITHOUT paginating, so every chunk came back truncated at exactly
    # 1000 rows and the readings past that point silently contributed nothing.
    # Measured on 2026-09-20: a 500-id chunk returned 1000 rows covering only
    # 278 readings -- 44% of the day's measurements missing from the rollup,
    # with no error anywhere.
    #
    # Paginating inside each chunk fixes it regardless of chunk size or how
    # many pollutants a station reports.
    m_rows = []
    for i in range(0, len(reading_ids), MEASUREMENT_CHUNK):
        chunk = reading_ids[i:i + MEASUREMENT_CHUNK]
        offset = 0
        while True:
            off = offset
            m = _execute(
                lambda: (client.table("measurements")
                               .select("reading_id, pollutant, value")
                               .in_("reading_id", chunk)
                               .range(off, off + PAGE - 1)),
                f"measurements {day} chunk {i}")
            batch = m.data or []
            m_rows.extend(batch)
            if len(batch) < PAGE:
                break
            offset += PAGE
    if not m_rows:
        return pd.DataFrame()

    # Guard against this class of bug returning silently. Every reading in the
    # day should contribute at least one measurement; a shortfall means rows
    # were dropped somewhere between the query and here.
    covered = {row["reading_id"] for row in m_rows}
    missing = len(reading_ids) - len(covered)
    if missing:
        print(f"  WARNING {day}: {missing} of {len(reading_ids)} readings "
              f"returned no measurements ({missing / len(reading_ids):.1%}). "
              f"Expect ~{len(reading_ids) * 3:,}+ rows, got {len(m_rows):,}.")

    measurements = pd.DataFrame(m_rows)
    joined = measurements.merge(
        readings.rename(columns={"id": "reading_id"}),
        on="reading_id",
    )
    joined["recorded_at"] = pd.to_datetime(joined["recorded_at"], utc=True)
    return joined[["monitor_id", "pollutant", "value", "recorded_at"]]


# Cap on how many tied timestamps to store per extreme. The tie count is kept
# separately, so a capped array is visibly capped. Sized from the observed
# distribution on 2026-09-12 (median 1, p90 4, p99 32): 24 keeps essentially
# every real tie while stopping a stuck sensor -- one reported the same value
# for all 96 intervals -- from bloating the row.
MAX_TIED_TIMESTAMPS = 24


def compute_rollup(joined: pd.DataFrame, target_date: date) -> List[Dict[str, Any]]:
    """Group by (monitor, pollutant) and compute distribution stats.

    Records EVERY timestamp at the daily minimum and maximum, not one of them.
    These columns exist to answer "when is the air cleanest here", and ties are
    not rare: on 2026-09-12, 42% of station-pollutant series had a tied minimum
    and 41% a tied maximum. Picking one arbitrarily also made the rollup
    non-deterministic, because idxmin() returns whichever matching row came
    first and PostgREST does not guarantee row order -- re-rolling the same day
    could change the answer.
    """
    if joined.empty:
        return []
    rows = []
    for (monitor_id, pollutant), g in joined.groupby(["monitor_id", "pollutant"]):
        values = g["value"].values
        vmin, vmax = float(np.min(values)), float(np.max(values))

        # Sorted so the stored order is deterministic regardless of the order
        # rows arrived in -- that non-determinism is what this replaces.
        min_ts = sorted(g.loc[g["value"] == vmin, "recorded_at"])
        max_ts = sorted(g.loc[g["value"] == vmax, "recorded_at"])

        rows.append({
            "monitor_id": monitor_id,
            "pollutant":  pollutant,
            "date":       target_date.isoformat(),
            "count":      int(len(values)),
            "mean":       float(np.mean(values)),
            "min":        vmin,
            "max":        vmax,
            # Kept as the EARLIEST of the tie so the legacy columns are at
            # least deterministic while anything still reads them.
            "min_ts":     min_ts[0].isoformat(),
            "max_ts":     max_ts[0].isoformat(),
            "min_ts_all": [t.isoformat() for t in min_ts[:MAX_TIED_TIMESTAMPS]],
            "max_ts_all": [t.isoformat() for t in max_ts[:MAX_TIED_TIMESTAMPS]],
            "min_tie_count": len(min_ts),
            "max_tie_count": len(max_ts),
            # Every reading identical: the sensor is stuck and "cleanest time"
            # is undefined. Worth flagging rather than silently averaging.
            "is_flat":    bool(vmin == vmax),
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
    failed: List[date] = []
    for d in dates:
        try:
            joined = fetch_day_measurements(client, d)
            rows = compute_rollup(joined, d)
        except Exception as e:
            # One unrecoverable day should not cost us the other 34. The job is
            # idempotent, so a failed day is simply re-rolled next run.
            print(f"  {d}: FAILED ({type(e).__name__}: {e}); continuing")
            failed.append(d)
            continue
        grand_measurements += len(joined)
        grand_rollup_rows += len(rows)
        print(f"  {d}: {len(joined):>6} measurements → {len(rows):>4} rollup rows")

        if not dry_run and rows:
            upsert_rollup(client, rows)

    print()
    print(f"Total: {grand_measurements} measurements read, "
          f"{grand_rollup_rows} rollup rows {'would be' if dry_run else 'were'} written.")
    if failed:
        print(f"FAILED days ({len(failed)}), will be retried on the next run: "
              f"{[d.isoformat() for d in failed]}")


if __name__ == "__main__":
    main()
