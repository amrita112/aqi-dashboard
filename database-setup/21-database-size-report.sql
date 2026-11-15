-- 21. Let the weekly prune job report how big the database is.
--
-- WHY THIS EXISTS. On 26 Oct 2026 the database was 1.25 GB against the free
-- plan's 500 MB, and the first anyone knew of it was Supabase's email. The
-- size estimates in the code were about five times too low, and nothing ever
-- compared them with the real figure. This lets prune_raw.py print the real
-- size every week and warn above 450 MB, while there is still time to act.
--
-- Read-only: it reports sizes and changes nothing. The figures are Postgres's
-- own, the same ones the Supabase dashboard shows.

CREATE OR REPLACE FUNCTION database_size_report()
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'database',       pg_database_size(current_database()),
    'readings',       pg_total_relation_size('public.readings'),
    'measurements',   pg_total_relation_size('public.measurements'),
    'readings_daily', pg_total_relation_size('public.readings_daily')
  );
$$;

COMMENT ON FUNCTION database_size_report() IS
  'Database and big-table sizes in bytes, indexes included. Called by the weekly prune-raw job.';

-- Only the jobs need this. Postgres lets everyone call a new function by
-- default, which would let any browser holding the anon key ask for it.
REVOKE ALL ON FUNCTION database_size_report() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION database_size_report() TO service_role;
