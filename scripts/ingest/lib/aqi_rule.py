"""
Which pollutants a composite AQI needs, and the composite itself.

The rule is read from lib/daily-quality-config.json (the "aqi_rules" and
"aqi_rule" keys), which the app's TypeScript reads too. It is used for:

  * readings.aqi_value  -- the AQI of ONE timestamp, written by both ingests
                           (ingest_recent_readings.py, daily_backfill_s3.py)
  * the daily AQI       -- scripts/forecast/daily_quality.py
  * the app             -- lib/api/daily-quality.ts

Default rule "both_pm": PM2.5 AND PM10 must both be present; NO2/SO2 join the
max when they are. Without a rule, a timestamp where only SO2 = 20 had arrived
got AQI 25 "Good" (audit §4.2) -- and because OpenAQ publishes pollutants in
separate bursts, that is common for the newest hours.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Iterable, Mapping, Optional

from scripts.ingest.lib.aqi_utils import compute_subindex

CONFIG_PATH = Path(__file__).resolve().parents[3] / "lib" / "daily-quality-config.json"
_CFG = json.loads(CONFIG_PATH.read_text())

AQI_RULES = dict(_CFG["aqi_rules"])
DEFAULT_AQI_RULE = _CFG["aqi_rule"]


def meets_aqi_rule(pollutants: Iterable[str], rule: str = DEFAULT_AQI_RULE) -> bool:
    """Does this set of pollutants carry enough to compute an AQI?"""
    spec = AQI_RULES[rule]
    have = set(pollutants)
    if len(have) < spec["min_pollutants"]:
        return False
    if not all(p in have for p in spec["required_all"]):
        return False
    if spec["required_any"] and not any(p in have for p in spec["required_any"]):
        return False
    return True


def composite_aqi(values: Mapping[str, float],
                  rule: str = DEFAULT_AQI_RULE) -> Optional[int]:
    """Max sub-index over `values` ({pollutant: canonical value}), or None when
    the pollutants present do not meet the rule. Negative values are ignored
    (sensor faults; compute_subindex refuses them)."""
    usable = {p: v for p, v in values.items() if v is not None and v >= 0}
    if not meets_aqi_rule(usable.keys(), rule):
        return None
    return max(compute_subindex(p, v) for p, v in usable.items())
