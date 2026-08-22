"""
Thin write-side wrapper around supabase-py for the ingest scripts.

Uses the service_role key (bypasses RLS) since ingest runs as an admin
process, not a logged-in user. NEVER put the service_role key in browser
code — it lives only in GitHub Actions secrets and local shell env vars.

Provides two upsert helpers keyed on the natural uniqueness constraints
added by database-setup/08-ingest-uniqueness.sql:

  upsert_readings     — dedup on (monitor_id, source, recorded_at)
  upsert_measurements — dedup on (reading_id, pollutant)

Both use `on_conflict="do_nothing"` semantics — the ingest is
idempotent, so a re-run of the same window is safe.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List

from supabase import Client, create_client

from scripts.ingest.lib.config import get_env


def canonical_ts(s: str) -> str:
    """Normalize an ISO timestamp string so keys generated on either side of a
    Supabase round-trip compare equal. Postgres/PostgREST canonicalizes
    timestamptz on the way out (e.g. 'Z' → '+00:00', drops trailing zeros in
    fractional seconds), so raw string comparison against a source-native
    format fails silently — measurements then can't find their parent reading
    UUID when linking. Applied on both write-time (recorded_at, _reading_key)
    and read-time (Supabase-returned recorded_at) sides."""
    return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc).isoformat()


def make_client() -> Client:
    """Build a Supabase client using service-role credentials."""
    url = get_env("SUPABASE_URL")
    key = get_env("SUPABASE_SERVICE_ROLE_KEY")
    return create_client(url, key)


# ─── Upsert helpers ─────────────────────────────────────────────────────────

def upsert_monitors(client: Client, monitors: Iterable[Dict[str, Any]]) -> int:
    """Insert-or-update monitors, keyed on the row's `id` (UUID we assign).

    Bootstrap uses this to keep the local monitor rows in sync with the
    OpenAQ station list. Idempotent — safe to re-run.
    """
    rows = list(monitors)
    if not rows:
        return 0
    result = client.table("monitors").upsert(rows).execute()
    return len(result.data or [])


def upsert_readings(
    client: Client, readings: Iterable[Dict[str, Any]]
) -> List[Dict[str, Any]]:
    """Insert readings, ignoring rows that conflict on the natural unique
    index (monitor_id, source, recorded_at). Returns the rows Supabase
    considered new (existing rows are silently skipped)."""
    rows = list(readings)
    if not rows:
        return []
    result = (
        client.table("readings")
              .upsert(rows, on_conflict="monitor_id,source,recorded_at", ignore_duplicates=True)
              .execute()
    )
    return result.data or []


def upsert_measurements(
    client: Client, measurements: Iterable[Dict[str, Any]]
) -> List[Dict[str, Any]]:
    """Insert measurements, ignoring rows that conflict on (reading_id, pollutant)."""
    rows = list(measurements)
    if not rows:
        return []
    result = (
        client.table("measurements")
              .upsert(rows, on_conflict="reading_id,pollutant", ignore_duplicates=True)
              .execute()
    )
    return result.data or []


def get_admin_user_id(client: Client) -> str:
    """Look up the seeded admin user (email `admin@aqi-dashboard.dev`).

    Every ingested reading needs a user_id (NOT NULL on the readings table).
    We attach ingest rows to the "AQI Dashboard Admin" profile created in
    database-setup/03-seed-data.sql. Long-term this should become a real
    admin account (see memory: project_admin_auth_followup).
    """
    result = (
        client.table("profiles")
              .select("id, display_name")
              .eq("display_name", "AQI Dashboard Admin")
              .limit(1)
              .execute()
    )
    if not result.data:
        raise SystemExit(
            "No profile found with display_name='AQI Dashboard Admin'. "
            "Run database-setup/03-seed-data.sql against your Supabase project "
            "before running the ingest."
        )
    return result.data[0]["id"]
