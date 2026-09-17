"""
Match OpenAQ stations to XKDR stations by name.

Both datasets ultimately describe the same CPCB monitor network and both carry
the same style of station name ("ITO, Delhi - CPCB"), so the name is the join
key. The two sources spell some names slightly differently, though, so a little
normalization is needed before the names line up.

The normalization here is deliberately CONSERVATIVE. A false pair -- two
genuinely different monitors joined as if they were one -- would show up as a
disagreement between the datasets and would be indistinguishable from a real
data problem, which is exactly the thing the comparison is trying to measure.
Missing a true pair only costs us sample size. So we only fold away differences
that are demonstrably notation for the same entity:

  - whitespace and comma/dash spacing            ("Dwarka-Sector 8, Delhi - DPCC ")
  - "New Delhi" vs "Delhi" as the city           ("ITO, New Delhi - CPCB")
  - a redundant state suffix                     ("Sector - 125, Noida, UP - UPPCB")

and nothing else. In particular the **agency suffix is preserved**: OpenAQ lists
both "Pusa, Delhi - DPCC" and "Pusa, Delhi - IMD", which are two real monitors at
the same locality run by different agencies. Dropping the suffix would merge them.
Fuzzy/edit-distance matching is deliberately NOT used -- on this data it happily
proposes Bandra->Kurla, IHBAS->ITO and Worli->Powai, all different places.

One OpenAQ name often maps to SEVERAL OpenAQ location_ids: the same physical
station gets re-registered over the years (R K Puram is ids 17, 5639 and 7044,
covering different periods). Those are unioned, not deduplicated -- together they
give better time coverage than any one of them.
"""

from __future__ import annotations

import json
import re
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any, Dict, List

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from scripts.ingest.lib.config import PROJECT_ROOT, TARGET_STATIONS_PATH  # noqa: E402

# Where the XKDR parquet export lives (downloaded by the XKDR quickstart notebook).
XKDR_GLOB = str(PROJECT_ROOT / "data" / "XKDR_data" / "data" / "v1"
                / "measurements" / "*" / "*" / "data.parquet")

# XKDR spells pollutants differently from OpenAQ; this is the translation.
# Restricted to the four the ingest pipeline tracks (TARGET_POLLUTANTS).
POLLUTANT_XKDR_TO_OPENAQ = {"PM2.5": "pm25", "PM10": "pm10",
                            "NO2": "no2", "SO2": "so2"}


def normalize_station_name(name: str) -> str:
    """Fold away spelling differences that don't change which monitor is meant."""
    s = " ".join(str(name).split()).strip()
    s = re.sub(r",\s*(UP|Uttar Pradesh)\b", ",", s, flags=re.I)   # state suffix
    s = re.sub(r"\bNew Delhi\b", "Delhi", s, flags=re.I)          # city convention
    s = re.sub(r"\s*,\s*", ", ", s)                               # comma spacing
    s = re.sub(r"\s*-\s*", "- ", s)                               # dash spacing
    return s.casefold().strip().rstrip(",").strip()


def xkdr_station_names(con) -> List[str]:
    """Distinct station names present in the XKDR export."""
    con.execute(
        f"CREATE OR REPLACE VIEW xkdr_raw AS SELECT * FROM read_parquet("
        f"'{XKDR_GLOB}', hive_partitioning=true, "
        f"hive_types={{'year':INTEGER,'month':INTEGER}})"
    )
    df = con.sql(
        "SELECT DISTINCT station_name FROM xkdr_raw WHERE station_name IS NOT NULL"
    ).df()
    return list(df["station_name"])


def build_crosswalk(con) -> Dict[str, Any]:
    """Pair OpenAQ target stations with XKDR stations.

    Returns a dict with the matched pairs plus the unmatched names on both
    sides, so callers can report match rate rather than silently dropping.
    """
    with TARGET_STATIONS_PATH.open("r", encoding="utf-8") as f:
        openaq_stations = json.load(f)["stations"]

    # normalized name -> [xkdr spellings]
    xkdr_by_key: Dict[str, List[str]] = defaultdict(list)
    for n in xkdr_station_names(con):
        xkdr_by_key[normalize_station_name(n)].append(n)

    # normalized name -> [openaq station records]
    openaq_by_key: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for s in openaq_stations:
        openaq_by_key[normalize_station_name(s["name"])].append(s)

    pairs = []
    for key, oa_list in sorted(openaq_by_key.items()):
        if key not in xkdr_by_key:
            continue
        pairs.append({
            "key":           key,
            "openaq_name":   oa_list[0]["name"],
            "openaq_ids":    [s["openaq_id"] for s in oa_list],
            "xkdr_names":    xkdr_by_key[key],
            "city":          oa_list[0]["city"],
        })

    matched_keys = {p["key"] for p in pairs}
    return {
        "pairs": pairs,
        "unmatched_openaq": sorted(
            oa[0]["name"] for k, oa in openaq_by_key.items() if k not in matched_keys
        ),
        "n_openaq_names": len(openaq_by_key),
        "n_xkdr_names":   len(xkdr_by_key),
    }


def matched_openaq_ids(crosswalk: Dict[str, Any]) -> List[int]:
    """Flat list of every OpenAQ location_id that has an XKDR counterpart."""
    return sorted({i for p in crosswalk["pairs"] for i in p["openaq_ids"]})
