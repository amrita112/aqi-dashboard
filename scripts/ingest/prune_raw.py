"""
Delete raw readings older than the retention window, once they are safely
rolled up.

Raw readings and measurements are the bulk of our Supabase usage: about 15 MB
per day of data, measured 26 Oct 2026 (~13,500 readings and ~49,000
measurements a day). The first estimate here was 1.27 MB/day, ten times too
low, and that is how the database passed the 500 MB free limit without anyone
noticing. readings_daily holds the same days at a small fraction of the size,
so once a day is rolled up the raw rows have done their job.

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

Every run, dry or not, ends with the database's total size against the free
limit (needs migration 21; skipped with a note if it has not been run).
"""

from __future__ import annotations

import os
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from scripts.ingest.lib.config import ist_day_bounds_utc, ist_today, to_ist_day  # noqa: E402
from scripts.ingest.lib.supabase_client import make_client  # noqa: E402

DEFAULT_RETENTION_DAYS = 30

# A floor, not a default. Below two weeks the forecast loses the observations
# it needs: it reads one recent day, but gaps mean it must be able to FIND one,
# and the measured p99.9 lookback is 28 days.
MIN_RETENTION_DAYS = 14

DEFAULT_MAX_DAYS_PER_RUN = 10
PAGE = 1000

# Space per row INCLUDING indexes and the PostGIS location column, measured
# 26 Oct 2026 as Supabase's table size divided by row count (readings 290 MB /
# 742k rows, measurements 547 MB / 2.67M rows). The previous figures, 84 and
# 37, left out indexes and were about five times too low.
BYTES_PER_READING = 390
BYTES_PER_MEASUREMENT = 205

# Supabase's free plan freezes the database above 500 MB. Warn while there is
# still room to act, not at the line itself.
FREE_LIMIT_MB = 500
WARN_ABOVE_MB = 450


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

    `day` is an IST calendar day, matching readings_daily.date. The bounds must
    be the same ones rollup_daily used, or the counts compare two different
    sets of readings and every day fails verification -- safely, since a
    failed day is skipped rather than deleted, but nothing would ever prune.
    """
    _start, _end = ist_day_bounds_utc(day)
    start, end = _start.isoformat(), _end.isoformat()

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


def next_day_with_readings(client, start: date, cutoff: date):
    """The first IST day on or after `start`, and before `cutoff`, that holds
    any raw reading. None when there is none.

    One query that jumps straight to the next day with data, instead of
    stepping through every calendar day. Raw history is sparse before
    September 2026 (a handful of days a year), and stepping a day at a time is
    what used to spend the whole run in early 2016.
    """
    lo, _ = ist_day_bounds_utc(start)
    hi, _ = ist_day_bounds_utc(cutoff)
    row = (client.table("readings").select("recorded_at")
                 .gte("recorded_at", lo.isoformat()).lt("recorded_at", hi.isoformat())
                 .order("recorded_at").limit(1).execute().data)
    if not row:
        return None
    return to_ist_day(datetime.fromisoformat(row[0]["recorded_at"]))


def report_database_size(client) -> None:
    """Print the database's size against the free limit. Never fails the job.

    Needs database_size_report() from migration 21. The table sizes are
    Postgres's own figures, the same ones the Supabase dashboard shows.
    Deleting rows does not shrink them by itself: the space is reused for new
    rows, but the reported size only drops after a VACUUM FULL.
    """
    try:
        sizes = client.rpc("database_size_report").execute().data or {}
    except Exception as exc:  # noqa: BLE001
        print(f"\nCould not read the database size (has migration 21 been run?): {exc}")
        return
    mb = {k: v / 1e6 for k, v in sizes.items()}
    total = mb.get("database", 0.0)
    print(f"\nDatabase size: {total:,.0f} MB of the {FREE_LIMIT_MB} MB free limit")
    for table in ("readings", "measurements", "readings_daily"):
        if table in mb:
            print(f"  {table:<15} {mb[table]:>7,.0f} MB")
    if total > WARN_ABOVE_MB:
        # A GitHub Actions annotation: shows on the run's summary page, so a
        # weekly run that is otherwise green still says it.
        print(f"::warning::Database is {total:,.0f} MB, above the {WARN_ABOVE_MB} MB "
              f"warning line (free limit {FREE_LIMIT_MB} MB).")


def delete_day(client, day: date) -> int:
    """Delete one IST day's readings. Measurements cascade.

    Same bounds as verify_day, so what was verified is exactly what is deleted.
    """
    _start, _end = ist_day_bounds_utc(day)
    start, end = _start.isoformat(), _end.isoformat()
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

    today = ist_today()
    cutoff = today - timedelta(days=retention)
    mode = "DELETING" if confirm else "DRY RUN (set CONFIRM_DELETE=yes to delete)"
    print(f"Retention: keep raw readings on or after {cutoff} ({retention} days)")
    print(f"Mode: {mode}")

    oldest = (client_ := make_client()).table("readings").select("recorded_at") \
        .order("recorded_at").limit(1).execute().data
    if not oldest:
        print("No readings at all; nothing to do.")
        return
    oldest_day = to_ist_day(datetime.fromisoformat(oldest[0]["recorded_at"]))
    if oldest_day >= cutoff:
        print(f"Oldest reading is {oldest_day}, already inside the window. Nothing to prune.")
        report_database_size(client_)
        return

    print(f"Oldest reading: {oldest_day}. Checking days before {cutoff}, "
          f"at most {max_days} verified day(s) this run.\n")

    prune_orphans = os.environ.get("PRUNE_ORPHANS", "").lower() == "yes"

    # WALK EVERY DAY THAT HAS DATA, AND CAP ONLY THE DAYS THAT VERIFY.
    # The cap used to count calendar days from the oldest reading, so the same
    # ten days of 2016 orphans filled every run and nothing after them was ever
    # looked at. Orphaned days are cheap to check and are stepped over without
    # counting. Failed days are also stepped over, but they get their own cap:
    # each one costs a full verification, and a run that finds many of them
    # should stop and say so rather than run into the job's timeout.
    verified, orphaned, skipped = [], [], []
    search_from = oldest_day
    while len(verified) < max_days and len(skipped) < max_days:
        day = next_day_with_readings(client_, search_from, cutoff)
        if day is None:
            break
        search_from = day + timedelta(days=1)
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
    freed = sum(s["readings"] * BYTES_PER_READING
                + s.get("measurements", 0) * BYTES_PER_MEASUREMENT
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

    # USAGE EVENTS AGE OUT HERE TOO. They are counts rather than measurements,
    # so none of the rollup verification above applies to them — ninety days is
    # simply longer than anyone has ever wanted to look back, and the table
    # would otherwise grow forever against a 500 MB budget. Guarded by the same
    # CONFIRM_DELETE as everything else in this job.
    if confirm:
        for fn, label in (
            ("purge_old_usage_events", "usage events older than 90 days"),
            ("purge_old_client_errors", "client errors older than 30 days"),
        ):
            try:
                removed = client_.rpc(fn).execute().data
                print(f"\nPurged {removed or 0:,} {label}.")
            except Exception as exc:  # noqa: BLE001
                # A bookkeeping table failing to prune must never fail the job
                # that protects the actual data budget.
                print(f"\nCould not run {fn}: {exc}")

    report_database_size(client_)

    if skipped:
        print("\nSkipped days need attention — they are not safely rolled up:")
        for day, reason in skipped:
            print(f"  {day}: {reason}")
        sys.exit(1)


if __name__ == "__main__":
    main()
