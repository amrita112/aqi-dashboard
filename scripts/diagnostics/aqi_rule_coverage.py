"""
How many monitoring stations can NEVER get an AQI under the AQI rule?

WHY THIS EXISTS (audit finding N5). The default AQI rule, "both_pm" in
lib/daily-quality-config.json, needs BOTH PM2.5 and PM10. A monitoring station
that does not measure one of them therefore never gets a daily AQI, an
aqi_value, a current AQI, an AQI forecast or an hourly AQI. The rule was kept
on purpose (see "_aqi_rule_coverage" in that file); this script recounts what
it costs, because the station list changes every week and the counts written
in the docs will drift.

WHAT IT READS. Only a LOCAL file: scripts/ingest/target_stations.json, the
station list the weekly bootstrap writes (one entry per station, with the
pollutants it has sensors for). It does not touch Supabase or the network.

  python3 scripts/diagnostics/aqi_rule_coverage.py            # current file
  python3 scripts/diagnostics/aqi_rule_coverage.py OTHER.json # another copy
  git show <commit>:scripts/ingest/target_stations.json > /tmp/old.json
  python3 scripts/diagnostics/aqi_rule_coverage.py /tmp/old.json

THE SAME COUNT FROM THE DATABASE. Since migration 32 the station list lives in
the monitor_sensors table. To count from there instead, paste this read-only
query into the Supabase SQL editor (it changes nothing):

  SELECT m.city,
         count(*) FILTER (WHERE NOT (s.params @> ARRAY['pm25','pm10'])) AS no_aqi,
         count(*) AS stations
  FROM (SELECT monitor_id, array_agg(DISTINCT parameter) AS params
        FROM monitor_sensors GROUP BY monitor_id) s
  JOIN monitors m ON m.id = s.monitor_id
  GROUP BY m.city ORDER BY m.city;

The rule itself is not copied here: it is applied with meets_aqi_rule, the
same function the ingests use, so the count follows the config if it changes.
"""

from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path

# The repository root, so `scripts.ingest.lib` can be imported however this
# file is started (it is two folders below the root).
REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))

from scripts.ingest.lib.aqi_rule import AQI_RULES, DEFAULT_AQI_RULE, meets_aqi_rule  # noqa: E402

DEFAULT_STATION_LIST = REPO_ROOT / "scripts" / "ingest" / "target_stations.json"


def count(stations: list[dict]) -> None:
    """Print, per city and for each rule, the stations that cannot get an AQI."""
    per_city = Counter(s["city"] for s in stations)
    for rule in AQI_RULES:
        failing = [s for s in stations if not meets_aqi_rule({x["parameter"] for x in s["sensors"]}, rule)]
        label = f"{rule} (default)" if rule == DEFAULT_AQI_RULE else rule
        print(f"\nRule {label}: {len(failing)} of {len(stations)} monitoring stations can never get an AQI")
        if not failing:
            continue
        # Which PM is missing, since that is what the both_pm rule turns on.
        no_pm10 = sum("pm10" not in {x["parameter"] for x in s["sensors"]} for s in failing)
        no_pm25 = sum("pm25" not in {x["parameter"] for x in s["sensors"]} for s in failing)
        print(f"  without PM10: {no_pm10}   without PM2.5: {no_pm25}")
        by_city = Counter(s["city"] for s in failing)
        for city in sorted(by_city):
            print(f"  {city:<12} {by_city[city]:>3} / {per_city[city]}")


def main() -> None:
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_STATION_LIST
    data = json.loads(path.read_text())
    print(f"Station list: {path} (generated {data.get('generated_at', 'unknown')})")
    count(data["stations"])


if __name__ == "__main__":
    main()
