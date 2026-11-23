-- 31. Drop six indexes nothing needs (~68 MB).
--
-- WHY. An index is a sorted lookup copy of one or more columns: it makes some
-- searches fast, but it takes disk space and EVERY insert must update it. The
-- 6-hourly ingest re-upserts days of readings, so each unneeded index costs
-- disk, write time and Disk IO budget (which matters on the smallest compute).
--
-- EVIDENCE. pg_stat_user_indexes, read 23 Nov 2026 (stats never reset, so the
-- counts cover the database's whole recent life):
--
--   index                          size    scans  why it can go
--   measurements_reading_id_idx    26 MB  597,237  duplicate: the unique index
--                                                  measurements_reading_pollutant_uniq
--                                                  is (reading_id, pollutant), so it
--                                                  answers "rows for this reading_id"
--                                                  just as well (incl. the cascade
--                                                  when the prune deletes readings)
--   readings_location_idx          26 MB        0  only served readings_within_radius()
--                                                  (migration 01), which no screen calls;
--                                                  nearest-station lookups use
--                                                  monitors_location_idx
--   measurements_pollutant_idx      8 MB        0  4 possible values: a lookup by
--                                                  pollutant alone reads most of the
--                                                  table anyway
--   readings_monitor_id_idx       3.4 MB        0  duplicate: readings_monitor_source_time_uniq
--                                                  is (monitor_id, source, recorded_at)
--   readings_user_id_idx          2.4 MB        0  from the crowdsourced-readings plan;
--                                                  nothing reads by user
--   readings_source_idx           2.3 MB        0  2-3 possible values
--
-- KEPT: every primary key and unique index (they enforce rules, not just speed:
-- measurements_pkey shows 0 scans but identifies rows), readings_recorded_at_idx
-- (the rollup and prune find days by it), and all monitors / readings_daily
-- indexes (small and used).
--
-- EFFECT. The space is freed at once -- dropping an index deletes its file; no
-- VACUUM needed. Each DROP takes a brief exclusive lock, so run it outside the
-- ingest's first minutes after 00/06/12/18 UTC. Nothing else changes; no data
-- is touched.
--
-- UNDO. Any of these can be rebuilt in a few minutes if a query turns slow,
-- e.g. CREATE INDEX measurements_pollutant_idx ON measurements (pollutant);
-- (definitions: migrations 01, 05, 06, 07).

BEGIN;

DROP INDEX measurements_reading_id_idx;
DROP INDEX measurements_pollutant_idx;
DROP INDEX readings_location_idx;
DROP INDEX readings_monitor_id_idx;
DROP INDEX readings_user_id_idx;
DROP INDEX readings_source_idx;

COMMIT;

-- Check afterwards (should list only the kept indexes):
--   SELECT relname, indexrelname, pg_size_pretty(pg_relation_size(indexrelid))
--   FROM pg_stat_user_indexes
--   WHERE relname IN ('readings', 'measurements') ORDER BY 1, 2;
