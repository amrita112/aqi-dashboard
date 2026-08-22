-- =============================================================================
-- Migration: Replace partial readings uniqueness index with a full one
-- =============================================================================
-- The partial index from 08 (WHERE monitor_id IS NOT NULL) can't be used as
-- an ON CONFLICT target through PostgREST/supabase-py — the client can't
-- attach the required WHERE predicate to the ON CONFLICT clause, so Postgres
-- returns 42P10 "no unique or exclusion constraint matching the ON CONFLICT
-- specification".
--
-- A plain unique index works because Postgres treats NULLs in a btree unique
-- index as distinct, so user-typed rows with monitor_id = NULL can still
-- coexist without violating uniqueness.
-- =============================================================================

DROP INDEX IF EXISTS readings_monitor_source_time_uniq;

CREATE UNIQUE INDEX readings_monitor_source_time_uniq
  ON readings (monitor_id, source, recorded_at);
