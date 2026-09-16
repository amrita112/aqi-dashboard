"""
Download the full OpenAQ S3 archive for our target stations to local disk.

This is a one-off bulk pull, not a scheduled job. It fetches every day-file
OpenAQ has ever published for the 178 stations in target_stations.json --
back to 2015 -- and stores them on local disk, still gzipped, in the same
layout S3 uses.

Why local disk and not Supabase:
  The raw archive is ~342 MB *compressed* (roughly 1.5-2 GB expanded into
  rows). Supabase's free tier is 500 MB total. Raw history cannot live in
  the database. The plan is: keep raw files here as the archive-of-record,
  then aggregate them into daily rollups (readings_daily) and load only
  those into Supabase. This script does the first half.

The download is resumable. A file already on disk with the byte size S3
reports is skipped, so re-running after an interrupt costs only the listing
pass. Nothing is ever deleted or overwritten in place.

Usage (from repo root):
    python3 scripts/ingest/historical/download_archive.py
    python3 scripts/ingest/historical/download_archive.py --relist
    python3 scripts/ingest/historical/download_archive.py --year-min 2019

Flags:
    --relist       Re-query S3 for the file listing instead of reusing the
                   cached manifest (the listing takes ~1 min for 178 stations).
    --year-min N   Only download files from year N onward (default: all).
    --workers N    Parallel downloads (default 16).
    --dry-run      Report what would be downloaded, write nothing.

No API key or AWS credentials needed -- the archive bucket is public.
"""

from __future__ import annotations

import argparse
import json
import sys
import threading
import time
import xml.etree.ElementTree as ET
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Dict, List, Tuple

import requests

# Make `scripts.ingest.lib` importable when run directly from the repo root.
sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from scripts.ingest.lib.config import (  # noqa: E402
    OPENAQ_S3_BASE,
    PROJECT_ROOT,
    TARGET_STATIONS_PATH,
)

# Where the raw archive lands. Gitignored -- this is data, not source.
ARCHIVE_DIR   = PROJECT_ROOT / "data" / "openaq-archive"
# Cached S3 listing so re-runs don't have to re-query 178 prefixes.
MANIFEST_PATH = ARCHIVE_DIR / "_file_manifest.json"

# S3's ListObjectsV2 XML responses are namespaced; every tag needs this prefix.
S3_NS = "{http://s3.amazonaws.com/doc/2006-03-01/}"


# ─── Listing ────────────────────────────────────────────────────────────────

def list_location_files(location_id: int) -> List[Dict[str, Any]]:
    """List every archived day-file for one OpenAQ location.

    Uses the public ListObjectsV2 API on the archive bucket. Results are
    paginated at 1000 keys, so we follow continuation tokens until S3 says
    the listing is complete. Returns one dict per file with its key, byte
    size, and the YYYYMMDD date parsed out of the filename.
    """
    files: List[Dict[str, Any]] = []
    token: str | None = None
    prefix = f"records/csv.gz/locationid={location_id}/"

    while True:
        params = {"list-type": "2", "prefix": prefix, "max-keys": "1000"}
        if token:
            params["continuation-token"] = token
        # S3 occasionally resets a connection mid-listing when we fan out 16
        # prefixes at once. Retry with a short backoff rather than losing the
        # whole station's listing.
        for attempt in range(4):
            try:
                r = requests.get(OPENAQ_S3_BASE, params=params, timeout=60)
                r.raise_for_status()
                break
            except Exception:
                if attempt == 3:
                    raise
                time.sleep(2 ** attempt)
        root = ET.fromstring(r.text)

        for c in root.findall(f"{S3_NS}Contents"):
            key = c.find(f"{S3_NS}Key").text
            # key looks like .../location-13-20150409.csv.gz
            day = key.rsplit("-", 1)[-1].replace(".csv.gz", "")
            files.append({
                "key":  key,
                "size": int(c.find(f"{S3_NS}Size").text),
                "date": day,
            })

        truncated = root.find(f"{S3_NS}IsTruncated")
        if truncated is not None and truncated.text == "true":
            token = root.find(f"{S3_NS}NextContinuationToken").text
        else:
            return files


def build_manifest(stations: List[Dict[str, Any]], workers: int) -> Dict[str, Any]:
    """Query S3 for every target station's file list, in parallel."""
    print(f"Listing S3 archive for {len(stations)} stations ...")
    manifest: Dict[str, Any] = {"generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ"),
                                "stations": {}}
    done = 0
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futures = {ex.submit(list_location_files, s["openaq_id"]): s for s in stations}
        for fut in as_completed(futures):
            st = futures[fut]
            try:
                files = fut.result()
            except Exception as e:
                print(f"  station {st['openaq_id']}: listing failed ({e})")
                files = []
            manifest["stations"][str(st["openaq_id"])] = {
                "city":  st["city"],
                "name":  st["name"],
                "files": files,
            }
            done += 1
            if done % 25 == 0:
                print(f"  ... listed {done}/{len(stations)} stations")

    ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)
    with MANIFEST_PATH.open("w", encoding="utf-8") as f:
        json.dump(manifest, f)
    return manifest


def load_manifest(stations: List[Dict[str, Any]], relist: bool, workers: int) -> Dict[str, Any]:
    """Reuse the cached listing if we have one, else go build it."""
    if MANIFEST_PATH.exists() and not relist:
        with MANIFEST_PATH.open("r", encoding="utf-8") as f:
            manifest = json.load(f)
        print(f"Using cached file manifest from {manifest.get('generated_at', 'unknown')} "
              f"(--relist to refresh)")
        return manifest
    return build_manifest(stations, workers)


# ─── Downloading ────────────────────────────────────────────────────────────

def local_path(key: str) -> Path:
    """Mirror the S3 key layout under ARCHIVE_DIR, minus the records/csv.gz/ prefix."""
    return ARCHIVE_DIR / key.replace("records/csv.gz/", "", 1)


def needs_download(entry: Dict[str, Any]) -> bool:
    """True unless we already hold this exact file at the size S3 reports.

    Size is a cheap integrity check: a truncated download from an interrupted
    run has the wrong length and gets re-fetched.
    """
    p = local_path(entry["key"])
    return not (p.exists() and p.stat().st_size == entry["size"])


# Each file is only ~1-3 KB, so the TLS handshake dominates if we open a new
# connection per request -- profiling an early run showed the process pegged in
# SSL handshakes (including post-quantum key generation) rather than transfer.
# A per-thread Session with a pooled adapter reuses one connection for all of
# that thread's files, turning 140k handshakes into a couple dozen.
_thread_local = threading.local()


def get_session() -> requests.Session:
    """Return this thread's persistent HTTP session, creating it on first use."""
    sess = getattr(_thread_local, "session", None)
    if sess is None:
        sess = requests.Session()
        adapter = requests.adapters.HTTPAdapter(
            pool_connections=4, pool_maxsize=4, max_retries=0
        )
        sess.mount("https://", adapter)
        _thread_local.session = sess
    return sess


def download_one(entry: Dict[str, Any]) -> Tuple[bool, int, str]:
    """Fetch one day-file to disk. Returns (ok, bytes_written, key)."""
    url = f"{OPENAQ_S3_BASE}/{entry['key']}"
    dest = local_path(entry["key"])
    dest.parent.mkdir(parents=True, exist_ok=True)
    # Transient DNS failures and connection resets are common when fanning out
    # tens of thousands of requests; retry a few times with backoff so one
    # blip doesn't leave a hole in the archive.
    for attempt in range(4):
        try:
            r = get_session().get(url, timeout=60)
            if r.status_code == 404:
                return False, 0, entry["key"]
            r.raise_for_status()
            # Write to a temp name and rename, so an interrupted run never
            # leaves a half-written file that looks complete to the next pass.
            tmp = dest.with_suffix(dest.suffix + ".part")
            tmp.write_bytes(r.content)
            tmp.replace(dest)
            return True, len(r.content), entry["key"]
        except Exception as e:
            if attempt == 3:
                print(f"  {entry['key']}: {e}")
                return False, 0, entry["key"]
            time.sleep(2 ** attempt)
    return False, 0, entry["key"]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--relist",   action="store_true", help="re-query S3 listing")
    ap.add_argument("--year-min", type=int, default=0,  help="skip files before this year")
    ap.add_argument("--workers",  type=int, default=16, help="parallel downloads")
    ap.add_argument("--dry-run",  action="store_true", help="report only, write nothing")
    args = ap.parse_args()

    with TARGET_STATIONS_PATH.open("r", encoding="utf-8") as f:
        stations = json.load(f)["stations"]

    manifest = load_manifest(stations, args.relist, args.workers)

    # Flatten to a single work list, applying the year filter.
    todo: List[Dict[str, Any]] = []
    total_files = 0
    by_year: Dict[str, int] = defaultdict(int)
    for loc_id, info in manifest["stations"].items():
        for entry in info["files"]:
            year = entry["date"][:4]
            if args.year_min and int(year) < args.year_min:
                continue
            total_files += 1
            by_year[year] += 1
            if needs_download(entry):
                todo.append(entry)

    todo_bytes = sum(e["size"] for e in todo)
    print(f"\n{total_files:,} files in scope across {len(manifest['stations'])} stations")
    print(f"{total_files - len(todo):,} already on disk, {len(todo):,} to fetch "
          f"({todo_bytes / 1e6:.0f} MB)")
    print("  " + "  ".join(f"{y}:{n:,}" for y, n in sorted(by_year.items())))

    if args.dry_run:
        print("\nDry run -- nothing written.")
        return
    if not todo:
        print("\nNothing to do; archive is complete.")
        return

    print(f"\nDownloading to {ARCHIVE_DIR} ...")
    ok = fail = 0
    written = 0
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        for i, (success, nbytes, _key) in enumerate(
            ex.map(download_one, todo), start=1
        ):
            if success:
                ok += 1
                written += nbytes
            else:
                fail += 1
            if i % 2000 == 0:
                rate = i / max(time.time() - t0, 1e-9)
                eta = (len(todo) - i) / max(rate, 1e-9)
                print(f"  ... {i:,}/{len(todo):,}  {written / 1e6:.0f} MB  "
                      f"{rate:.0f} files/s  ETA {eta / 60:.1f} min")

    print(f"\nDone in {(time.time() - t0) / 60:.1f} min. "
          f"{ok:,} files fetched ({written / 1e6:.0f} MB), {fail:,} failed.")
    print(f"Archive root: {ARCHIVE_DIR}")


if __name__ == "__main__":
    main()
