"""
Shared configuration for the ingest scripts.

Target cities, pollutant list, file paths, and small constants used by both
the bootstrap and the ingest scripts. Kept small and hardcoded — v1 scope
is Delhi + Mumbai + Bangalore, PM2.5 + PM10 + NO2 + SO2. When those change,
this is the one place to edit.
"""

from __future__ import annotations

import os
from datetime import date, datetime, timedelta, timezone
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
# Boxes were drawn from the actual station distribution (all 764 Indian OpenAQ
# locations plotted against each city centre), not from map intuition: wide
# enough to take in the built-up area and its industrial fringe, tight enough
# to exclude neighbouring towns that would distort a city average. Chennai's
# stops short of Gummidipoondi (47 km out) and Kanchipuram (63 km) for exactly
# that reason.
TARGET_CITIES: Dict[str, Tuple[float, float, float, float]] = {
    "Delhi NCR": (28.40, 76.80, 28.90, 77.50),
    "Mumbai":    (18.85, 72.75, 19.30, 73.05),
    "Bangalore": (12.80, 77.40, 13.15, 77.80),
    # Added 2026-09-18. Station counts measured the same day (target-pollutant
    # stations in box / of those, reporting within 7 days):
    "Hyderabad": (17.20, 78.20, 17.60, 78.70),   # 18 / 13
    "Chennai":   (12.85, 80.05, 13.30, 80.35),   # 14 /  8
    "Kolkata":   (22.40, 88.20, 22.80, 88.50),   # 18 / 13  (includes Howrah)
    # Added 2026-09-19. 19 stations in box / 14 reporting within 2 days.
    # Spans Pune proper and Pimpri-Chinchwad, which is one contiguous metro and
    # is how the app should present it. Stops short of Mahad (51 km out) and
    # Kanchipuram-style satellites that would distort a city average.
    "Pune":      (18.40, 73.70, 18.72, 73.98),   # 19 / 14
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


# ─── Time base ──────────────────────────────────────────────────────────────
#
# The pipeline has two clocks and they must never be confused again. What
# follows is the convention; everything else in the codebase defers to it.
#
#   STORED AS UTC          readings.recorded_at, readings.created_at,
#                          readings_daily.min_ts / max_ts and their _all arrays.
#                          These are INSTANTS. An instant has no timezone
#                          problem -- it converts losslessly whenever it is
#                          read, so storage stays UTC exactly as OpenAQ sends it.
#
#   GROUPED BY IST         readings_daily.date, forecast_daily.target_date,
#                          diurnal_shape.hour, the day-of-year a climatology is
#                          indexed by. These are CALENDAR LABELS, not instants.
#                          A calendar label cannot be converted after the fact:
#                          once a daily mean has been averaged over the wrong
#                          24 hours, no downstream timezone conversion recovers
#                          it, and raw readings are pruned at 30 days.
#
# This is an India-only product, so the calendar is India's. It is also what
# the XKDR history already uses -- its `collected_at` is a naive local
# timestamp, so every climatology, alpha and diurnal shape fitted from it is on
# IST days and IST hours. Rolling our own readings up on UTC days put a
# 7.6%-of-level artefact (2.26 ug/m3 PM2.5, against a 5.4 ug/m3 median
# day-to-day change) between the climatology and the observation it is
# subtracted from. Measured 2026-09-22.
#
# The one deliberate exception is which S3 FILES to fetch: OpenAQ partitions
# its archive by UTC date, so daily_backfill_s3.py asks for UTC days. That is
# reading the source's filing system, not choosing our own calendar.

IST = timezone(timedelta(hours=5, minutes=30))


def ist_today() -> date:
    """Today's date in India, regardless of where the job is running."""
    return datetime.now(IST).date()


def ist_day_bounds_utc(day: date) -> Tuple[datetime, datetime]:
    """The UTC instants bounding one IST calendar day, half-open [start, end).

    IST day D runs 00:00-24:00 IST, which is 18:30 UTC on D-1 to 18:30 UTC on
    D. Queries against recorded_at (UTC) use these bounds; they must never be
    built from UTC midnight.
    """
    start = datetime.combine(day, datetime.min.time(), tzinfo=IST)
    return start.astimezone(timezone.utc), (start + timedelta(days=1)).astimezone(timezone.utc)


def to_ist_day(ts: datetime) -> date:
    """The IST calendar day a UTC instant belongs to."""
    return ts.astimezone(IST).date()
