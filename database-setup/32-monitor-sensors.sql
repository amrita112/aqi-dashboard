-- 32. monitor_sensors: the station/sensor list the ingest reads, kept in the
--     database instead of in git.
--
-- WHY. The ingest needs to know which OpenAQ sensors to ask for and which of
-- our monitors each one belongs to. That list ("the manifest") used to live in
-- scripts/ingest/target_stations.json, which the weekly bootstrap workflow
-- committed back to main. Since main started requiring pull requests, that
-- commit has been refused every week, so the file froze on 18 Oct 2026 (171
-- stations / 624 sensors) while OpenAQ moved on (176 / 633 by 23 Nov) and the
-- newest stations were never ingested. Keeping the list here removes git from
-- the loop: the bootstrap writes this table, the ingest reads it.
--
-- WHAT IS ALREADY ELSEWHERE. Station-level facts are on `monitors` already:
-- name, latitude, longitude, city (migration 13) and the OpenAQ location id,
-- encoded in serial_number as 'openaq:{id}' (written by the bootstrap). So
-- this table only adds what monitors cannot hold: one row per SENSOR. The
-- OpenAQ location id is repeated per row (openaq_location_id) so the ingest
-- never has to parse it out of serial_number.
--
-- "When was the list generated?" is max(updated_at): the bootstrap stamps every
-- row it writes with the time of the run, so no separate metadata table.
--
-- WHO WRITES IT. scripts/ingest/bootstrap_stations.py, weekly via
-- .github/workflows/bootstrap-weekly.yml, with the service key. It upserts the
-- sensors it found and deletes the ones OpenAQ no longer lists -- but refuses
-- to change anything if the new list is much smaller than the stored one (a
-- sign of a failed download, not of stations closing).
--
-- WHO READS IT. The two ingest jobs (ingest_recent_readings.py,
-- daily_backfill_s3.py), with the service key, via
-- scripts/ingest/lib/manifest.py. Visitors never need it: the app shows
-- monitors and readings, not OpenAQ sensor ids. So no public read.
--
-- SIZE. ~633 rows of about 150 bytes each including the primary-key index:
-- roughly 100-150 KB. Negligible against the 500 MB budget.
--
-- WHAT COULD GO WRONG. Additive only: a new, empty table; nothing existing is
-- touched. Until the bootstrap has filled it, the ingest finds it empty and
-- falls back to scripts/ingest/target_stations.json (with a warning in the
-- log), i.e. it behaves exactly as it does today. The ON DELETE CASCADE means
-- deleting a monitor also deletes its sensor rows -- which is what should
-- happen, since a sensor without a monitor cannot be ingested.
--
-- If TARGET_POLLUTANTS in scripts/ingest/lib/config.py ever gains a pollutant
-- (e.g. o3), the CHECK below must be widened in a new migration, or the
-- bootstrap's write will be rejected.
--
-- ORDER. Any time. Run this, then run the "Bootstrap stations (weekly
-- refresh)" workflow once by hand (or wait for Sunday). Afterwards:
--   SELECT parameter, count(*), count(DISTINCT monitor_id), max(updated_at)
--   FROM monitor_sensors GROUP BY parameter;

BEGIN;

CREATE TABLE monitor_sensors (
  -- OpenAQ's own sensor id (one pollutant at one station). Stable while the
  -- sensor lives; OpenAQ re-registers sensors under new ids now and then, and
  -- the bootstrap then replaces the old row with the new one.
  sensor_id           BIGINT      PRIMARY KEY,
  -- Our monitor (station) this sensor's readings are stored under.
  monitor_id          UUID        NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  -- Which pollutant it measures, in our spelling (matches measurements.pollutant
  -- and TARGET_POLLUTANTS).
  parameter           TEXT        NOT NULL CHECK (parameter IN ('pm25', 'pm10', 'no2', 'so2')),
  -- OpenAQ's location (station) id; the S3 archive files are named by it.
  openaq_location_id  BIGINT      NOT NULL,
  -- Time of the bootstrap run that last wrote this row.
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE monitor_sensors IS
  'OpenAQ sensors the ingest polls, one row per sensor, linked to monitors. Written weekly by scripts/ingest/bootstrap_stations.py; read by the ingest jobs. Service key only.';

-- RLS on with no policies: nobody but the service key (which bypasses RLS)
-- can read or write.
ALTER TABLE monitor_sensors ENABLE ROW LEVEL SECURITY;

-- Grants (Supabase no longer adds these automatically for new tables, from
-- 30 Oct 2026). Visitors: nothing. The bootstrap and ingest: read and write.
REVOKE ALL ON monitor_sensors FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON monitor_sensors TO service_role;

COMMIT;
