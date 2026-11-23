"""
Build station_monthly_climate: each station's air, month by month, year by year.

WHAT IT IS FOR. The "Historical trends" chart (Map tab station card and Trends
tab) shows the yearly pattern of AQI or PM2.5: for each month of the year, the
average daily low, the average daily mean and the average daily high, plus one
faint line per year. The app cannot compute that on the fly -- it would mean
reading 15 years of daily rows per tap -- so this job boils the history down
once a month into a small table (~20k rows, a few MB) that the app reads.

WHERE THE HISTORY COMES FROM. The same three sources the monthly forecast
refit stacks (scripts/forecast/baselines.py), which never overlap in time:

  1. xkdr_daily_history.parquet           Storage bucket `forecast-history`.
                                          CPCB data via XKDR, 2009 -> 1 Sep 2025.
                                          Daily values built from HOURLY data.
  2. openaq_archive_daily_history.parquet same bucket. OpenAQ archive,
                                          2 Sep 2025 -> 16 Aug 2026.
                                          Daily values built from 15-MINUTE data.
  3. readings_daily (database)            our own nightly rollups, 17 Aug 2026 on.

  The step from hourly to 15-minute data around Sep 2025 makes daily HIGHS
  look a little higher afterwards (more, shorter readings catch sharper
  peaks; median max/mean ratio 1.57 vs 1.63). Daily MEANS are unaffected. The
  chart says so in a footnote.

  This file has its OWN loader rather than calling baselines._load_history_file,
  on purpose: that loader belongs to the forecast, and any change to it means
  re-running the forecast verification notebook (CLAUDE.md). Reading three
  more columns (min, max) here costs nothing and keeps the two jobs apart.

WHICH DAYS COUNT. Only COMPLETE days, by the one rule the forecast and the
app's charts already share (scripts/forecast/daily_quality.py, numbers in
lib/daily-quality-config.json): >= 12 hours of readings for the station's own
cadence, values 0-2000, and for AQI both PM2.5 and PM10 present that day.

HOW A DAY'S AQI IS WORKED OUT -- the same way the app's history charts do it
(lib/api/data.ts, getHistoryAqi), so this chart and the "Past month" chart
agree:

  mean  each complete pollutant's DAILY MEAN -> its sub-index -> the highest.
        This is the official Indian AQI (CPCB's NAQI is defined on 24-hour
        averages), so the MEAN line is the number to quote.
  min   each pollutant's lowest reading of the day -> its sub-index -> the
        highest of those. It is "the AQI at the day's cleanest moment", built
        from short-period readings, so it is NOT an official AQI value.
  max   same, from each pollutant's highest reading of the day. Also not
        official: a 15-minute peak run through a 24-hour scale.

WHAT IT WRITES. One row per (monitor_id, metric, year, month), metric 'pm25'
or 'aqi', with n_days (complete days in that month), the mean of the daily
means, mins and maxes, the lowest and highest daily mean, and the 10th and
90th percentile of the daily means. The app decides how many days make a
month count and how many years make a month worth drawing (lib/api/climate.ts),
so those thresholds can change without rebuilding this table.

FULL REBUILD, EVERY TIME. Every row is recomputed from scratch and upserted,
then rows this run no longer produces (a station removed, a day now judged
incomplete) are deleted. A safety check refuses to write at all if this run
produced far fewer rows than the table holds -- the signature of a failed
download rather than a real change.

USAGE (from the repo root):

    # Read-only: download, compute, print counts and sanity numbers.
    python -m scripts.climate.build_station_climate
    python -m scripts.climate.build_station_climate --show "Anand Vihar"

    # Write to Supabase (needs migration 30 run first):
    python -m scripts.climate.build_station_climate --apply

    # Use local copies of the two history files instead of downloading
    # (the same env vars the forecast refit honours):
    XKDR_HISTORY_FILE=data/xkdr_daily_history.parquet \
    ARCHIVE_HISTORY_FILE=data/openaq_archive_daily_history.parquet \
    python -m scripts.climate.build_station_climate

Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (read from .env.local locally).
"""

from __future__ import annotations

import argparse
import io
import math
import os
import sys
import time
from datetime import datetime, timezone
from typing import Dict, Iterable, List, Optional, Tuple

import numpy as np
import pandas as pd

# Pure helpers only -- nothing in daily_quality.py is changed by this job.
from scripts.forecast.daily_quality import (
    DEFAULT_AQI_RULE,
    complete_mask,
    station_day_aqi,
)

# ─── Configurable constants ─────────────────────────────────────────────────

# The table this job owns (database-setup/30-station-monthly-climate.sql).
CLIMATE_TABLE = "station_monthly_climate"

# The metrics the app lets a person choose (lib/prefs.ts, Measurement).
METRICS = ("pm25", "aqi")

# Where the long history lives. Same bucket and objects the forecast refit
# reads (scripts/forecast/baselines.py, HISTORY_FILES); repeated here rather
# than imported so this job never depends on the forecast's loader.
HISTORY_BUCKET = "forecast-history"
HISTORY_FILES: Tuple[Tuple[str, str, str], ...] = (
    # (object in the bucket, env var for a local copy, --flag name)
    ("xkdr_daily_history.parquet", "XKDR_HISTORY_FILE", "xkdr_file"),
    ("openaq_archive_daily_history.parquet", "ARCHIVE_HISTORY_FILE", "archive_file"),
)

# The four pollutants we store; together they make the composite AQI.
POLLUTANTS = ("pm25", "pm10", "no2", "so2")

# Columns read from each source. min/max are what the forecast does not need
# and this chart does.
COLUMNS = ["monitor_id", "date", "pollutant", "mean", "min", "max", "count", "source"]

# readings_daily rows tagged 'xkdr' are an older copy of the XKDR history that
# now lives in Storage; reading both would count those days twice. Same
# exclusion the forecast refit makes.
EXCLUDED_DB_SOURCES = ("xkdr",)

# If the same station, pollutant and day ever appears in two inputs (it should
# not -- the date ranges do not overlap), keep the copy from the input listed
# first. Our own rollups are the freshest reading of a day.
SOURCE_PRIORITY = ("readings_daily", "openaq_archive_daily_history.parquet",
                   "xkdr_daily_history.parquet")

# PostgREST returns at most 1000 rows per request.
PAGE = 1000

# Rows per upsert request: well under PostgREST's body limits.
UPSERT_BATCH = 500

# Decimal places kept in the table. One is finer than any monitor's accuracy.
ROUND_DP = 1

# The 10th / 90th percentiles of the daily means, stored alongside the
# lowest and highest so the app can draw a typical range that one freak day
# cannot stretch.
LOW_QUANTILE, HIGH_QUANTILE = 0.10, 0.90

# SAFETY: refuse to write if this run produced fewer than this share of the
# rows already in the table. A real change (a station retired) moves the count
# by a few percent; a broken download moves it by most of it.
MIN_SHARE_OF_EXISTING = 0.8

# Rough on-disk bytes per row (tuple ~110 B + primary-key index ~50 B), for
# the size estimate printed in a dry run. The 500 MB free-tier budget is why
# this number is printed at all.
EST_BYTES_PER_ROW = 160

# Retries for Supabase's intermittent 502s (same reasoning as rollup_daily.py).
QUERY_RETRIES = 4


# ─── Reading ────────────────────────────────────────────────────────────────

def _execute(build_query, what: str):
    """Run a PostgREST query, retrying transient gateway failures.

    `build_query` returns a FRESH query each call: a failed builder cannot be
    re-run.
    """
    delay = 2.0
    for attempt in range(QUERY_RETRIES):
        try:
            return build_query().execute()
        except Exception as e:  # noqa: BLE001 -- re-raised unless transient
            transient = any(t in str(e) for t in ("502", "503", "504", "timeout",
                                                  "Bad Gateway", "JSON could not be generated"))
            if attempt == QUERY_RETRIES - 1 or not transient:
                raise
            print(f"  {what}: {type(e).__name__}, retrying in {delay:.0f}s")
            time.sleep(delay)
            delay *= 2


def page_all(build_query, what: str) -> List[dict]:
    """Every row of an ORDERED query, 1000 at a time.

    `build_query()` must return a query already ordered on a unique key, or
    pages can overlap or skip rows.
    """
    rows: List[dict] = []
    offset = 0
    while True:
        r = _execute(lambda: build_query().range(offset, offset + PAGE - 1), what)
        batch = r.data or []
        rows += batch
        if len(batch) < PAGE:
            return rows
        offset += PAGE


def load_history_file(client, obj: str, local: Optional[str]) -> pd.DataFrame:
    """One daily-history parquet file, from Storage or from a local copy.

    A missing file is an ERROR, not an empty frame: a chart silently missing
    fifteen years of XKDR history would still look plausible.
    """
    if local:
        print(f"  reading {obj} from {local}")
        source = local
    else:
        print(f"  downloading {HISTORY_BUCKET}/{obj} from Storage ...")
        source = io.BytesIO(client.storage.from_(HISTORY_BUCKET).download(obj))
    df = pd.read_parquet(source, columns=COLUMNS)
    df["date"] = df["date"].astype(str)
    df = df[df["pollutant"].isin(POLLUTANTS)].reset_index(drop=True)
    df["input"] = obj
    print(f"    {len(df):,} rows, {df['date'].min()} -> {df['date'].max()}")
    return df


def load_readings_daily(client, since: str = "2009-01-01") -> pd.DataFrame:
    """Our own daily rollups, paged out of readings_daily.

    Ordered by (date, monitor_id, pollutant) -- the table's primary key, so
    the order is stable and no row is skipped or read twice -- and restarted
    inside each calendar year so no offset gets deep enough to time out (same
    approach as the forecast refit).
    """
    this_year = datetime.now(timezone.utc).year
    frames = []
    for year in range(int(since[:4]), this_year + 1):
        def query(year=year):
            q = (client.table("readings_daily")
                       .select("monitor_id, date, pollutant, mean, min, max, count, "
                               "source, is_complete")
                       .in_("pollutant", list(POLLUTANTS))
                       .gte("date", max(since, f"{year}-01-01"))
                       .lte("date", f"{year}-12-31"))
            for s in EXCLUDED_DB_SOURCES:
                q = q.neq("source", s)
            return q.order("date").order("monitor_id").order("pollutant")
        rows = page_all(query, f"readings_daily {year}")
        if rows:
            frames.append(pd.DataFrame(rows))
            print(f"    readings_daily {year}: {len(rows):,} rows")
    if not frames:
        return pd.DataFrame(columns=COLUMNS + ["is_complete", "input"])
    df = pd.concat(frames, ignore_index=True)
    df["date"] = df["date"].astype(str)
    df["input"] = "readings_daily"
    return df


def load_monitors(client) -> pd.DataFrame:
    """id, name, city of every monitor: rows for unknown ids cannot be written
    (the table's foreign key), and names make the sanity printout readable."""
    rows = page_all(lambda: client.table("monitors").select("id, name, city").order("id"),
                    "monitors")
    return pd.DataFrame(rows, columns=["id", "name", "city"])


# ─── Computing (pure: no network, tested in tests/test_station_climate.py) ───

def stack_sources(frames: Iterable[pd.DataFrame]) -> Tuple[pd.DataFrame, int]:
    """Stack the inputs, keeping one copy of any station-pollutant-day.

    Returns (frame, number of duplicate rows dropped). The inputs are not
    supposed to overlap; the count is printed so an overlap would be noticed.
    """
    frames = [f for f in frames if f is not None and not f.empty]
    if not frames:
        return pd.DataFrame(columns=COLUMNS + ["input"]), 0
    df = pd.concat(frames, ignore_index=True)
    rank = {name: i for i, name in enumerate(SOURCE_PRIORITY)}
    df["_rank"] = df["input"].map(rank).fillna(len(rank))
    before = len(df)
    df = (df.sort_values("_rank", kind="stable")
            .drop_duplicates(subset=["monitor_id", "pollutant", "date"], keep="first")
            .drop(columns="_rank")
            .sort_values(["monitor_id", "pollutant", "date"], kind="stable")
            .reset_index(drop=True))
    return df, before - len(df)


def _subindex_or_nan(pollutant: str, value) -> float:
    """Sub-index of one concentration, or NaN where the app would skip it
    (missing or negative: lib/api/data.ts only sub-indexes values >= 0)."""
    from scripts.ingest.lib.aqi_utils import compute_subindex
    if value is None or (isinstance(value, float) and math.isnan(value)) or value < 0:
        return float("nan")
    return float(compute_subindex(pollutant, float(value)))


def daily_values(complete: pd.DataFrame, rule: str = DEFAULT_AQI_RULE) -> pd.DataFrame:
    """One row per station, metric and COMPLETE day: mean, min, max.

    `complete` must already be filtered to complete days. Dates are IST
    calendar days as stored (YYYY-MM-DD strings) and are never converted.

    Returns columns monitor_id, metric, date, mean, min, max, source.
    """
    cols = ["monitor_id", "metric", "date", "mean", "min", "max", "source"]
    if complete.empty:
        return pd.DataFrame(columns=cols)

    # PM2.5: the day's own statistics. A missing min/max falls back to the
    # mean, as the app's history chart does.
    pm = complete[complete["pollutant"] == "pm25"]
    pm25 = pd.DataFrame({
        "monitor_id": pm["monitor_id"].values,
        "metric": "pm25",
        "date": pm["date"].values,
        "mean": pm["mean"].astype(float).values,
        "min": pm["min"].astype(float).fillna(pm["mean"].astype(float)).values,
        "max": pm["max"].astype(float).fillna(pm["mean"].astype(float)).values,
        "source": pm["source"].values,
    })

    # AQI: the official daily value from the shared rule (station_day_aqi),
    # then the day's low and high the way the app's history chart builds them.
    aqi = station_day_aqi(complete, rule)
    if aqi.empty:
        return pm25[cols].reset_index(drop=True)
    days = aqi[["monitor_id", "date", "aqi"]]
    rows = complete.merge(days[["monitor_id", "date"]], on=["monitor_id", "date"])
    rows = rows.assign(
        min_si=[_subindex_or_nan(p, v) for p, v in zip(rows["pollutant"], rows["min"])],
        max_si=[_subindex_or_nan(p, v) for p, v in zip(rows["pollutant"], rows["max"])],
    )
    ext = (rows.groupby(["monitor_id", "date"], as_index=False)
               .agg(min=("min_si", "max"), max=("max_si", "max"),
                    # Which input the day came from; one per day in practice.
                    source=("source", "first")))
    aqi_daily = days.merge(ext, on=["monitor_id", "date"], how="left")
    aqi_daily["mean"] = aqi_daily["aqi"].astype(float)
    # No usable low/high (every pollutant's min missing) -> the day's AQI,
    # exactly as the app falls back.
    aqi_daily["min"] = aqi_daily["min"].fillna(aqi_daily["mean"])
    aqi_daily["max"] = aqi_daily["max"].fillna(aqi_daily["mean"])
    aqi_daily["metric"] = "aqi"

    out = pd.concat([pm25[cols], aqi_daily[cols]], ignore_index=True)
    return out.sort_values(["monitor_id", "metric", "date"], kind="stable").reset_index(drop=True)


def monthly_climate(daily: pd.DataFrame) -> pd.DataFrame:
    """Station x metric x year x month summaries of the complete days.

    Year and month are read straight off the IST date string ("2025-11-03" ->
    2025, 11), never through a timestamp, so no timezone can move a day into
    the neighbouring month.
    """
    out_cols = ["monitor_id", "metric", "year", "month", "n_days",
                "mean_of_means", "mean_of_mins", "mean_of_maxes",
                "lowest_daily_mean", "highest_daily_mean",
                "p10_daily_mean", "p90_daily_mean", "sources"]
    if daily.empty:
        return pd.DataFrame(columns=out_cols)

    d = daily.copy()
    d["year"] = d["date"].str.slice(0, 4).astype(int)
    d["month"] = d["date"].str.slice(5, 7).astype(int)
    keys = ["monitor_id", "metric", "year", "month"]
    g = d.groupby(keys)
    out = g.agg(
        n_days=("date", "nunique"),
        mean_of_means=("mean", "mean"),
        mean_of_mins=("min", "mean"),
        mean_of_maxes=("max", "mean"),
        lowest_daily_mean=("mean", "min"),
        highest_daily_mean=("mean", "max"),
    )
    out["p10_daily_mean"] = g["mean"].quantile(LOW_QUANTILE)
    out["p90_daily_mean"] = g["mean"].quantile(HIGH_QUANTILE)
    # Which inputs the month was built from, e.g. "openaq_archive,xkdr" for
    # Sep 2025. Lets the chart say which months straddle the data change.
    out["sources"] = g["source"].agg(lambda s: ",".join(sorted(set(map(str, s)))))
    out = out.reset_index()

    stats = ["mean_of_means", "mean_of_mins", "mean_of_maxes", "lowest_daily_mean",
             "highest_daily_mean", "p10_daily_mean", "p90_daily_mean"]
    out[stats] = out[stats].round(ROUND_DP)
    out["n_days"] = out["n_days"].astype(int)
    return out[out_cols].sort_values(keys).reset_index(drop=True)


def build(frames: Iterable[pd.DataFrame], known_monitors: Optional[set] = None,
          rule: str = DEFAULT_AQI_RULE, log=print) -> pd.DataFrame:
    """The whole computation, inputs to table rows. Network-free."""
    df, dupes = stack_sources(frames)
    log(f"  stacked: {len(df):,} station-pollutant-days "
        f"({dupes:,} duplicates across inputs dropped)")
    if known_monitors is not None:
        unknown = ~df["monitor_id"].isin(known_monitors)
        if unknown.any():
            log(f"  dropped {int(unknown.sum()):,} rows for "
                f"{df.loc[unknown, 'monitor_id'].nunique()} monitor ids not in `monitors`")
        df = df[~unknown]
    df = df.dropna(subset=["mean"])

    # Complete days only: the stored is_complete flag where readings_daily
    # has one, the same rule computed where the history files have none.
    complete = df[complete_mask(df)]
    log(f"  complete: {len(complete):,} of {len(df):,} station-pollutant-days")

    daily = daily_values(complete, rule)
    for m in METRICS:
        log(f"  {m}: {int((daily['metric'] == m).sum()):,} complete station-days")
    return monthly_climate(daily)


# ─── Writing ────────────────────────────────────────────────────────────────

KEY = ["monitor_id", "metric", "year", "month"]


def existing_keys(client) -> Optional[set]:
    """Keys already in the table, or None if the table does not exist yet."""
    try:
        rows = page_all(lambda: client.table(CLIMATE_TABLE)
                                      .select("monitor_id, metric, year, month")
                                      .order("monitor_id").order("metric")
                                      .order("year").order("month"),
                        CLIMATE_TABLE)
    except Exception as e:  # noqa: BLE001
        msg = str(e)
        if "does not exist" in msg or "PGRST205" in msg or "42P01" in msg:
            return None
        raise
    return {(r["monitor_id"], r["metric"], int(r["year"]), int(r["month"])) for r in rows}


def to_records(table: pd.DataFrame) -> List[dict]:
    """DataFrame rows -> JSON-ready dicts (plain ints/floats, NaN -> None)."""
    now = datetime.now(timezone.utc).isoformat()
    recs = []
    for r in table.to_dict("records"):
        rec = {}
        for k, v in r.items():
            if isinstance(v, (np.integer,)):
                v = int(v)
            elif isinstance(v, (np.floating, float)):
                v = None if math.isnan(v) else float(v)
            rec[k] = v
        rec["updated_at"] = now
        recs.append(rec)
    return recs


def write(client, table: pd.DataFrame, before: Optional[set]) -> None:
    """Upsert every row, then delete the rows this run no longer produced."""
    if before is None:
        raise SystemExit(f"Table {CLIMATE_TABLE} does not exist yet: run "
                         f"database-setup/30-station-monthly-climate.sql first.")
    produced = set(zip(table.monitor_id, table.metric,
                       table.year.astype(int), table.month.astype(int)))
    if before and len(produced) < MIN_SHARE_OF_EXISTING * len(before):
        raise SystemExit(
            f"REFUSING TO WRITE: this run produced {len(produced):,} rows but the "
            f"table holds {len(before):,} (below {MIN_SHARE_OF_EXISTING:.0%}). That "
            f"usually means an input failed to load. Nothing was changed.")

    recs = to_records(table)
    for i in range(0, len(recs), UPSERT_BATCH):
        chunk = recs[i:i + UPSERT_BATCH]
        _execute(lambda: client.table(CLIMATE_TABLE)
                               .upsert(chunk, on_conflict=",".join(KEY)), "upsert")
    print(f"  upserted {len(recs):,} rows")

    stale = sorted(before - produced)
    for mid, metric, year, month in stale:
        _execute(lambda: client.table(CLIMATE_TABLE).delete()
                               .eq("monitor_id", mid).eq("metric", metric)
                               .eq("year", year).eq("month", month), "delete")
    print(f"  deleted {len(stale):,} rows no longer produced")


# ─── Reporting ──────────────────────────────────────────────────────────────

MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
          "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def show_station(table: pd.DataFrame, monitors: pd.DataFrame, needle: str,
                 min_days: int = 10) -> None:
    """Print the all-years monthly pattern for stations whose name matches.

    Uses the app's default month threshold (lib/api/climate.ts,
    DEFAULT_MIN_DAYS_PER_MONTH) and the median across years. A quick look
    only: the app's unusual-year screen is not applied here.
    """
    hits = monitors[monitors["name"].str.contains(needle, case=False, na=False)]
    for _, m in hits.iterrows():
        rows = table[(table.monitor_id == m["id"]) & (table.n_days >= min_days)]
        if rows.empty:
            continue
        print(f"\n  {m['name']} ({m['city']})")
        for metric in METRICS:
            r = rows[rows.metric == metric]
            if r.empty:
                continue
            by_month = r.groupby("month").agg(
                years=("year", "nunique"), lo=("mean_of_mins", "median"),
                mean=("mean_of_means", "median"), hi=("mean_of_maxes", "median"))
            print(f"    {metric}  years {r.year.min()}-{r.year.max()}")
            for month, x in by_month.iterrows():
                print(f"      {MONTHS[month - 1]}  n={x.years:>2}  "
                      f"low {x.lo:6.0f}  mean {x['mean']:6.0f}  high {x.hi:6.0f}")


def main(argv: Optional[List[str]] = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true",
                      help="Compute and report, write nothing (the default).")
    mode.add_argument("--apply", action="store_true",
                      help="Write the rebuilt table to Supabase.")
    for obj, env, flag in HISTORY_FILES:
        ap.add_argument(f"--{flag.replace('_', '-')}", dest=flag,
                        default=os.environ.get(env, "").strip() or None,
                        help=f"Local copy of {obj} (default: ${env}, else download).")
    ap.add_argument("--show", action="append", default=[],
                    help="Print the monthly pattern for stations whose name contains this.")
    args = ap.parse_args(argv)

    from scripts.ingest.lib.supabase_client import make_client
    client = make_client()
    t0 = time.time()

    print("Loading monitors ...")
    monitors = load_monitors(client)
    print(f"  {len(monitors):,} monitors")

    print("Loading history ...")
    frames = [load_history_file(client, obj, getattr(args, flag))
              for obj, _env, flag in HISTORY_FILES]
    frames.append(load_readings_daily(client))

    print("Computing ...")
    table = build(frames, known_monitors=set(monitors["id"]))

    stations = table.monitor_id.nunique()
    print(f"\nResult: {len(table):,} rows, {stations} stations, "
          f"years {table.year.min()}-{table.year.max()}, "
          f"~{len(table) * EST_BYTES_PER_ROW / 1e6:.1f} MB estimated in the database")
    for metric in METRICS:
        t = table[table.metric == metric]
        print(f"  {metric}: {len(t):,} station-months, "
              f"median {t.groupby('monitor_id').year.nunique().median():.0f} years per station")

    before = existing_keys(client)
    if before is None:
        print(f"\n  {CLIMATE_TABLE} does not exist yet (migration 30 not run).")
    else:
        produced = set(zip(table.monitor_id, table.metric,
                           table.year.astype(int), table.month.astype(int)))
        print(f"\n  table now holds {len(before):,} rows; this run would add "
              f"{len(produced - before):,}, update {len(produced & before):,}, "
              f"delete {len(before - produced):,}")

    for needle in args.show:
        show_station(table, monitors, needle)

    if args.apply:
        print("\nWriting ...")
        write(client, table, before)
    else:
        print("\nDry run: nothing written. Re-run with --apply to write.")
    print(f"Done in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    sys.exit(main())
