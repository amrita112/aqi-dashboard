"""
Delete raw readings older than the retention window, once they are safely
rolled up.

Raw readings and measurements are the bulk of our Supabase usage (~1.27 MB/day
for seven cities). readings_daily holds the same days at roughly 1/40th the
size, so once a day is rolled up the raw rows have done their job.

THIS IS IRREVERSIBLE. measurements.reading_id is ON DELETE CASCADE, so deleting
a reading silently deletes its measurements too, and nothing here can bring
either back -- the S3 archive can re-supply recent days, but not indefinitely.
The script is therefore built to refuse rather than guess.

Safety, in order of importance:

  1. DRY RUN BY DEFAULT. Deleting requires CONFIRM_DELETE=yes. There is no
     flag that means "probably fine".
  2. A day is deleted only if it VERIFIES: readings_daily must hold the same
     number of measurements the raw rows contain for that day. Not "a rollup
     row exists" -- the counts must reconcile. The pagination bug we fixed on
     2026-09-20 wrote rollup rows that looked fine while silently dropping 44%
     of the measurements behind them; a presence check would have passed and
     the raw evidence would have been deleted.
  3. Days that fail verification are reported and SKIPPED, not deleted. The
     job exits non-zero if any day fails, so a scheduled run surfaces it.
  4. A floor on the retention window, so a typo cannot delete this week.

Usage (from repo root):
    python3 -m scripts.ingest.prune_raw                    # dry run
    CONFIRM_DELETE=yes python3 -m scripts.ingest.prune_raw # actually delete

Env vars:
    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
    RETENTION_DAYS=30     keep raw readings this recent (minimum 14)
    CONFIRM_DELETE=yes    required to delete anything
    MAX_DAYS_PER_RUN=10   ceiling on days deleted in one run
    PRUNE_ORPHANS=yes     also delete readings that have no measurements at all
"""

from __future__ import annotations

import os
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from scripts.ingest.lib.supabase_client import make_client  # noqa: E402

DEFAULT_RETENTION_DAYS = 30

# A floor, not a default. Below two weeks the forecast loses the observations
# it needs: it reads one recent day, but gaps mean it must be able to FIND one,
# and the measured p99.9 lookback is 28 days.
MIN_RETENTION_DAYS = 14

DEFAULT_MAX_DAYS_PER_RUN = 10
PAGE = 1000


def _page_all(query_fn) -> List[Dict[str, Any]]:
    rows, offset = [], 0
    while True:
        batch = query_fn(offset).execute().data or []
        rows += batch
        if len(batch) < PAGE:
            return rows
        offset += PAGE


def verify_day(client, day: date) -> Tuple[bool, str, Dict[str, int]]:
    """Is this day safe to delete?

    Safe means readings_daily accounts for every raw measurement on that day.
    Comparing COUNTS rather than merely checking that rollup rows exist is the
    point: a rollup can be present and wrong.
    """
    start = f"{day.isoformat()}T00:00:00+00:00"
    end = f"{(day + timedelta(days=1)).isoformat()}T00:00:00+00:00"

    readings = _page_all(lambda off: (
        client.table("readings").select("id")
              .gte("recorded_at", start).lt("recorded_at", end)
              .range(off, off + PAGE - 1)))
    n_readings = len(readings)
    if n_readings == 0:
        return False, "no raw readings (nothing to do)", {"readings": 0}

    # Measurements actually present for those readings.
    ids = [r["id"] for r in readings]
    n_measurements = 0
    for i in range(0, len(ids), 200):
        chunk = ids[i:i + 200]
        offset = 0
        while True:
            batch = (client.table("measurements").select("reading_id")
                           .in_("reading_id", chunk)
                           .range(offset, offset + PAGE - 1).execute().data or [])
            n_measurements += len(batch)
            if len(batch) < PAGE:
                break
            offset += PAGE

    # A reading with NO measurements at all cannot be rolled up -- there is
    # nothing to summarise. These exist: 577 readings spanning 2016-2025 carry
    # an aqi_value but no pollutant rows, almost certainly orphaned by the
    # canonical_ts timestamp bug on the first live run. They would otherwise
    # block this job forever, since no amount of re-rolling can produce a
    # rollup row for them. Classified separately and deleted only on an
    # explicit opt-in, because "no data" and "data we failed to check" should
    # not be treated the same way.
    if n_measurements == 0:
        return False, "ORPHANED", {"readings": n_readings, "measurements": 0,
                                   "rollup_rows": 0, "rollup_count": 0}

    rollup = _page_all(lambda off: (
        client.table("readings_daily").select("count")
              .eq("date", day.isoformat())
              .range(off, off + PAGE - 1)))
    if not rollup:
        return False, "NOT ROLLED UP", {"readings": n_readings,
                                        "measurements": n_measurements,
                                        "rollup_rows": 0, "rollup_count": 0}

    rollup_total = sum(int(r["count"]) for r in rollup)
    stats = {"readings": n_readings, "measurements": n_measurements,
             "rollup_rows": len(rollup), "rollup_count": rollup_total}

    if rollup_total != n_measurements:
        return False, (f"rollup accounts for {rollup_total:,} measurements but raw "
                       f"holds {n_measurements:,}"), stats
    return True, "ok", stats


def delete_day(client, day: date) -> int:
    """Delete one day's readings. Measurements cascade."""
    start = f"{day.isoformat()}T00:00:00+00:00"
    end = f"{(day + timedelta(days=1)).isoformat()}T00:00:00+00:00"
    deleted = 0
    while True:
        ids = [r["id"] for r in (
            client.table("readings").select("id")
                  .gte("recorded_at", start).lt("recorded_at", end)
                  .limit(500).execute().data or [])]
        if not ids:
            return deleted
        client.table("readings").delete().in_("id", ids).execute()
        deleted += len(ids)


def main() -> None:
    retention = int(os.environ.get("RETENTION_DAYS", DEFAULT_RETENTION_DAYS))
    if retention < MIN_RETENTION_DAYS:
        raise SystemExit(
            f"RETENTION_DAYS={retention} is below the {MIN_RETENTION_DAYS}-day floor. "
            f"The forecast needs to be able to find a recent observation, and the "
            f"measured p99.9 lookback is 28 days. Refusing.")

    confirm = os.environ.get("CONFIRM_DELETE", "").lower() == "yes"
    max_days = int(os.environ.get("MAX_DAYS_PER_RUN", DEFAULT_MAX_DAYS_PER_RUN))

    today = datetime.now(timezone.utc).date()
    cutoff = today - timedelta(days=retention)
    mode = "DELETING" if confirm else "DRY RUN (set CONFIRM_DELETE=yes to delete)"
    print(f"Retention: keep raw readings on or after {cutoff} ({retention} days)")
    print(f"Mode: {mode}")

    oldest = (client_ := make_client()).table("readings").select("recorded_at") \
        .order("recorded_at").limit(1).execute().data
    if not oldest:
        print("No readings at all; nothing to do.")
        return
    oldest_day = datetime.fromisoformat(oldest[0]["recorded_at"]).date()
    if oldest_day >= cutoff:
        print(f"Oldest reading is {oldest_day}, already inside the window. Nothing to prune.")
        return

    candidates = []
    d = oldest_day
    while d < cutoff and len(candidates) < max_days:
        candidates.append(d)
        d += timedelta(days=1)
    print(f"Oldest reading: {oldest_day}. Considering {len(candidates)} day(s), "
          f"capped at {max_days}.\n")

    prune_orphans = os.environ.get("PRUNE_ORPHANS", "").lower() == "yes"

    verified, orphaned, skipped = [], [], []
    for day in candidates:
        ok, reason, stats = verify_day(client_, day)
        if stats.get("readings", 0) == 0:
            continue
        line = (f"  {day}  raw {stats['readings']:>6} readings / "
                f"{stats.get('measurements', 0):>6} measurements  "
                f"rollup {stats.get('rollup_count', 0):>6}")
        if ok:
            verified.append((day, stats))
            print(f"{line}  VERIFIED")
        elif reason == "ORPHANED":
            orphaned.append((day, stats))
            print(f"{line}  ORPHANED (no measurements; nothing to roll up)")
        else:
            skipped.append((day, reason))
            print(f"{line}  SKIP: {reason}")

    if orphaned and prune_orphans:
        verified += orphaned
        orphaned = []

    print(f"\n{len(verified)} day(s) verified, {len(skipped)} skipped.")
    freed = sum(s["readings"] * 84 + s.get("measurements", 0) * 37
                for _, s in verified) / 1e6
    print(f"Deleting these would free roughly {freed:.1f} MB.")

    if not verified:
        print("Nothing to delete.")
    elif not confirm:
        print("\nDRY RUN — nothing deleted. Set CONFIRM_DELETE=yes to proceed.")
    else:
        total = 0
        for day, _ in verified:
            n = delete_day(client_, day)
            total += n
            print(f"  deleted {n:,} readings for {day} (measurements cascaded)")
        print(f"\nDeleted {total:,} readings across {len(verified)} day(s).")

    if orphaned:
        n = sum(s["readings"] for _, s in orphaned)
        print(f"\n{len(orphaned)} day(s) hold {n:,} ORPHANED readings — an aqi_value "
              f"with no measurements behind it.")
        print("  They cannot be rolled up, so re-running the rollup will not help.")
        print("  Delete them with PRUNE_ORPHANS=yes once you are satisfied they are")
        print("  the known canonical_ts casualties and not a live linkage failure.")

    if skipped:
        print("\nSkipped days need attention — they are not safely rolled up:")
        for day, reason in skipped:
            print(f"  {day}: {reason}")
        sys.exit(1)


if __name__ == "__main__":
    main()
