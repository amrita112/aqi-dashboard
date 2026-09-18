"""
Shared configuration for the ingest scripts.

Target cities, pollutant list, file paths, and small constants used by both
the bootstrap and the ingest scripts. Kept small and hardcoded — v1 scope
is Delhi + Mumbai + Bangalore, PM2.5 + PM10 + NO2 + SO2. When those change,
this is the one place to edit.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Dict, Tuple

from dotenv import load_dotenv

# ─── Paths ──────────────────────────────────────────────────────────────────

# scripts/ingest/lib/config.py  →  parents[3] is the project root
PROJECT_ROOT = Path(__file__).resolve().parents[3]
INGEST_DIR   = PROJECT_ROOT / "scripts" / "ingest"

# Load .env.local at project root BEFORE any script calls get_env(). This is
# the same file Next.js reads for the web app; keeping ingest and web on the
# same env file means one place to manage OPENAQ_API_KEY, SUPABASE_URL, etc.
# On GitHub Actions the file doesn't exist and this call is a no-op — env
# vars come from repository secrets instead.
load_dotenv(PROJECT_ROOT / ".env.local")

# Populated by bootstrap_stations.py; consumed by both ingest scripts.
TARGET_STATIONS_PATH = INGEST_DIR / "target_stations.json"

# ─── Product scope ──────────────────────────────────────────────────────────

# Target cities as bounding boxes (lat_min, lng_min, lat_max, lng_max).
# City-core + inner suburbs. Any OpenAQ station whose coordinates fall inside
# one of these boxes is ingested; anything else is ignored.
TARGET_CITIES: Dict[str, Tuple[float, float, float, float]] = {
    "Delhi NCR": (28.40, 76.80, 28.90, 77.50),
    "Mumbai":    (18.85, 72.75, 19.30, 73.05),
    "Bangalore": (12.80, 77.40, 13.15, 77.80),
}

# Pollutants we ingest. Matches the CHECK constraint on measurements.pollutant
# and covers 96–99% of "dominant pollutant" events in the target cities per
# the 2026-08-13 analysis in notebooks/aqi_data_sources_survey.ipynb.
# CO and O3 were dropped: CO showed near-zero dominance after fixing the
# ppb-vs-mg/m³ unit bug; O3 sits under 4% across all target cities.
TARGET_POLLUTANTS = frozenset({"pm25", "pm10", "no2", "so2"})

# ─── Sensor freshness ───────────────────────────────────────────────────────

# OpenAQ re-registers a station's sensors periodically and leaves the old ones
# in place, returning nothing forever. On 2026-09-18 our 178-station manifest
# held 906 target-pollutant sensors whose last-reading ages were almost
# perfectly bimodal: 409 within two days, 440 more than three years stale
# (mostly frozen at 2018-02-22), and only 46 anywhere in between.
#
# Polling the dead half cost ~9 minutes of every 6-hourly run for nothing, and
# pushed the job close to its 30-minute workflow timeout.
#
# The cutoff sits in that empty middle, so its exact value barely matters; 90
# days is chosen because a sensor silent for a whole season cannot help a
# "what is the air like now" app. Pruning is safe because it is not permanent:
# bootstrap re-runs weekly and re-adds any sensor that starts reporting again.
DEFAULT_SENSOR_MAX_AGE_DAYS = 90


def get_sensor_max_age_days() -> int:
    """Freshness cutoff for keeping a sensor in the manifest (env-overridable)."""
    raw = os.environ.get("SENSOR_MAX_AGE_DAYS", "").strip()
    return int(raw) if raw else DEFAULT_SENSOR_MAX_AGE_DAYS


# OpenAQ constants
OPENAQ_COUNTRY_ID_INDIA = 9   # v3 country_id (was 27 in v2)
OPENAQ_API_BASE = "https://api.openaq.org/v3"
OPENAQ_S3_BASE  = "https://openaq-data-archive.s3.amazonaws.com"

# ─── Environment variables (validated at script start) ──────────────────────

def get_env(name: str, required: bool = True) -> str:
    """Read an env var; error out with a clear message if it's missing."""
    value = os.environ.get(name, "")
    if required and not value:
        raise SystemExit(
            f"Environment variable {name} is not set. "
            f"For local runs: `export {name}=...`. "
            f"For GitHub Actions: set as a repository secret."
        )
    return value


def which_city(lat: float, lng: float) -> str | None:
    """Return the target-city name a coordinate falls into, or None."""
    for city, (la_min, ln_min, la_max, ln_max) in TARGET_CITIES.items():
        if la_min <= lat <= la_max and ln_min <= lng <= ln_max:
            return city
    return None
