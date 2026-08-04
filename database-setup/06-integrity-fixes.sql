-- =============================================================================
-- Integrity Fixes
-- =============================================================================
-- Adds validation constraints, tightened RLS policies, a future-timestamp
-- trigger, a hardened SECURITY DEFINER function, and missing indexes to the
-- `readings` and `profiles` tables. Intended to be run once on a fresh
-- setup, after files 01-05.
--
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Fix 1: Restrict `readings.source` to the four known values.
-- -----------------------------------------------------------------------------
-- Prevents typos like 'OpenAQ' (wrong case) or 'gov' from silently inserting
-- and then never matching any dashboard filter. This is the DB-level
-- last line of defence.

ALTER TABLE readings
  ADD CONSTRAINT readings_source_valid
  CHECK (source IN ('user', 'openaq', 'simulated', 'government'));

-- -----------------------------------------------------------------------------
-- Fix 2: Restrict `readings.latitude` to the physical range [-90, 90].
-- -----------------------------------------------------------------------------
-- Does NOT catch swapped lat/lng (both in-range but wrong content) — that
-- belongs in app-layer validation.

ALTER TABLE readings
  ADD CONSTRAINT readings_latitude_valid
  CHECK (latitude BETWEEN -90 AND 90);

-- -----------------------------------------------------------------------------
-- Fix 3: Restrict `readings.longitude` to the physical range [-180, 180].
-- -----------------------------------------------------------------------------

ALTER TABLE readings
  ADD CONSTRAINT readings_longitude_valid
  CHECK (longitude BETWEEN -180 AND 180);

-- -----------------------------------------------------------------------------
-- Fix 4: Reject `readings.recorded_at` values more than 1 hour in the future.
-- -----------------------------------------------------------------------------
-- Implemented as a trigger because Postgres CHECK constraints require
-- immutable expressions and now() is not immutable. 

CREATE OR REPLACE FUNCTION check_recorded_at_not_future()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.recorded_at > now() + interval '1 hour' THEN
    RAISE EXCEPTION
      'recorded_at cannot be more than 1 hour in the future (got %)',
      NEW.recorded_at;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER readings_no_future_recorded_at
  BEFORE INSERT OR UPDATE ON readings
  FOR EACH ROW
  EXECUTE FUNCTION check_recorded_at_not_future();

-- -----------------------------------------------------------------------------
-- Fix 5: Raise the aqi_value cap from 500 to 1000.
-- -----------------------------------------------------------------------------
-- Delhi winter readings sometimes exceed 500 (CPCB has recorded values above
-- 700 during severe smog events). 
--
-- Drops the original auto-named constraint from 01-schema.sql before adding
-- the new one under an explicit name.

ALTER TABLE readings DROP CONSTRAINT readings_aqi_value_check;

ALTER TABLE readings
  ADD CONSTRAINT readings_aqi_value_valid
  CHECK (aqi_value >= 0 AND aqi_value <= 1000);

-- -----------------------------------------------------------------------------
-- Fix 6: Add WITH CHECK to the UPDATE RLS policies on readings and profiles.
-- -----------------------------------------------------------------------------
-- USING alone controls which rows can be selected for update; without a
-- matching WITH CHECK, a user could UPDATE their own row and reassign its
-- owner column (user_id / id) to a different user. WITH CHECK forces the
-- row's after-state to still satisfy the ownership rule.

ALTER POLICY "Users can update their own readings"
  ON readings
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

ALTER POLICY "Users can update their own profile"
  ON profiles
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

-- -----------------------------------------------------------------------------
-- Fix 7: Tighten the INSERT RLS on readings to also enforce source = 'user'.
-- -----------------------------------------------------------------------------
-- The original INSERT policy only checked user_id, so a logged-in user could
-- POST a reading with source = 'government' and their submission would appear
-- masquerading as an official CPCB reading. Restricting source to 'user' at
-- the RLS layer forces citizen submissions to identify themselves. Admin
-- ingest scripts use the service_role key (which bypasses RLS), so
-- OpenAQ / government / simulated ingest paths are unaffected.

ALTER POLICY "Users can insert their own readings"
  ON readings
  WITH CHECK (auth.uid() = user_id AND source = 'user');

-- -----------------------------------------------------------------------------
-- Fix 8: Pin search_path on the SECURITY DEFINER function handle_new_user.
-- -----------------------------------------------------------------------------
-- SECURITY DEFINER means this function runs with the owner's privileges, not
-- the caller's. Without an explicit search_path, a hostile user could shadow
-- referenced objects (functions, tables) by putting a malicious version
-- earlier in the resolution order, and their code would then run with the
-- owner's privileges — classic privilege escalation. Pinning search_path to
-- (public, pg_temp) locks the resolution order to trusted schemas.
--

CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id) VALUES (NEW.id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- -----------------------------------------------------------------------------
-- Fix 9: Add B-tree indexes on readings.user_id and readings.source.
-- -----------------------------------------------------------------------------
-- Common queries filter by these columns ("show me my submissions",
-- "filter by source = 'openaq'"). 

CREATE INDEX readings_user_id_idx ON readings (user_id);
CREATE INDEX readings_source_idx  ON readings (source);
