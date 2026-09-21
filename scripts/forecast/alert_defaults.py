"""
Seed default notification thresholds, one per city and pollutant.

The threshold is the MEDIAN of the daily maximum across October-February,
rounded down to the nearest 10.

Why the median of the daily max, rather than a health guideline: a guideline
number (WHO's 15 ug/m3, say) would fire every single day in Delhi and never be
dismissable. A city-relative default fires on roughly half the season's days by
construction, which makes it meaningful on the day it fires and gives the user
an obvious direction to move it. It is a starting point tuned to where they
live, not a health claim.

Rounded DOWN, not to nearest, so the shipped default is never less sensitive
than the number it was derived from.

Usage (from repo root):
    python3 -m scripts.forecast.alert_defaults
    python3 -m scripts.forecast.alert_defaults --dry-run
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from scripts.forecast.baselines import (  # noqa: E402
    CITIES, XKDR_GLOB, _all_xkdr_names, _city_sql_case,
)
from scripts.forecast.refit_params import APP_TO_ANALYSIS  # noqa: E402
from scripts.ingest.lib.aqi_utils import compute_subindex  # noqa: E402
from scripts.ingest.lib.supabase_client import make_client  # noqa: E402

# Oct-Feb: the pollution season plus its shoulders. Wider than the Oct-Jan
# window used for scoring forecasts, because a threshold should cover the whole
# period someone would want warning during.
ALERT_MONTHS = (10, 11, 12, 1, 2)
ROUND_TO = 10
MIN_DAYS = 60


def compute() -> List[Dict[str, Any]]:
    import duckdb

    con = duckdb.connect()
    con.execute(
        f"CREATE VIEW m AS SELECT * FROM read_parquet('{XKDR_GLOB}', "
        f"hive_partitioning=true, hive_types={{'year':INTEGER,'month':INTEGER}})"
    )
    months = ", ".join(str(m) for m in ALERT_MONTHS)
    sd = con.sql(f"""
        SELECT {_city_sql_case()} AS city, station_id AS station,
               CAST(collected_at AS DATE) AS d,
               CASE parameter_name WHEN 'PM2.5' THEN 'pm25' WHEN 'PM10' THEN 'pm10'
                    WHEN 'NO2' THEN 'no2' WHEN 'SO2' THEN 'so2' END AS pollutant,
               max(value) AS vmax
        FROM m
        WHERE parameter_name IN ('PM2.5','PM10','NO2','SO2')
          AND city_name IN ({_all_xkdr_names()})
          AND value BETWEEN 0 AND 2000
          AND EXTRACT(month FROM collected_at) IN ({months})
        GROUP BY 1,2,3,4 HAVING count(*) >= 12
    """).df()

    # PM2.5: the city's daily max is the mean across stations of their daily
    # maxima -- consistent with how every other city number here is built.
    pm = (sd[sd.pollutant == "pm25"].groupby(["city", "d"])["vmax"]
            .mean().reset_index())

    # AQI: sub-index each station's daily max, take the max across pollutants
    # for that station-day, then average across stations.
    sd = sd.assign(sub=[compute_subindex(p, v) for p, v in zip(sd.pollutant, sd.vmax)])
    sd = sd.dropna(subset=["sub"])
    idx = sd.groupby(["city", "station", "d"])["sub"].idxmax()
    aqi = sd.loc[idx].groupby(["city", "d"])["sub"].mean().reset_index()

    now = datetime.now(timezone.utc).isoformat()
    rows: List[Dict[str, Any]] = []
    for analysis_city in CITIES:
        app_city = next((a for a, x in APP_TO_ANALYSIS.items() if x == analysis_city),
                        analysis_city)
        for pollutant, frame, col in (("pm25", pm, "vmax"), ("aqi", aqi, "sub")):
            vals = frame[frame.city == analysis_city][col]
            if len(vals) < MIN_DAYS:
                print(f"  {app_city:<11} {pollutant:<5} only {len(vals)} days; skipping")
                continue
            raw = float(np.median(vals))
            threshold = float(int(raw // ROUND_TO) * ROUND_TO)
            share = float((vals >= threshold).mean())
            rows.append({"city": app_city, "pollutant": pollutant,
                         "threshold": threshold,
                         "source": f"median daily max, Oct-Feb (raw {raw:.0f})",
                         "n_days": int(len(vals)), "fitted_at": now})
            print(f"  {app_city:<11} {pollutant:<5} median {raw:>6.0f} -> "
                  f"default {threshold:>6.0f}   fires on {share:.0%} of season days"
                  f"   ({len(vals)} days)")
    return rows


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    print(f"Default alert thresholds — median daily max over months {ALERT_MONTHS}, "
          f"rounded down to {ROUND_TO}\n")
    rows = compute()
    print(f"\n{len(rows)} defaults computed")
    if args.dry_run:
        print("Dry run — nothing written.")
        return
    client = make_client()
    client.table("alert_defaults").upsert(rows, on_conflict="city,pollutant").execute()
    print(f"  alert_defaults: {len(rows)} rows upserted")


if __name__ == "__main__":
    main()
