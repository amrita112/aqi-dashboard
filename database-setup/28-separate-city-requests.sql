-- 28. City requests get their own table.
--
-- WHY. Migration 18 put "add my city" requests into petition_signatures,
-- told apart by a `kind` column, to avoid duplicating the privacy machinery.
-- In practice that mixed two different things in one place:
--
--   * petition_count() -- the public petition total on /petition -- was never
--     updated to filter on `kind`, so EVERY city request was also counted as a
--     petition signature. The number shown publicly, and quoted to funders,
--     was inflated by the city requests.
--   * Anyone reading the table (the Supabase table editor, an export) sees
--     signatories and city requesters interleaved.
--
-- WHAT CHANGES
--
--   1. A new table, city_requests, with the same privacy rules as the
--      petition: nobody can read it with the public key, rows expire after two
--      years, the consent text is frozen on each row.
--   2. Every existing city request is MOVED there -- same id, name, email,
--      city, consent text, withdrawal token, created_at and expires_at -- and
--      deleted from petition_signatures. The file checks the numbers add up
--      before it commits.
--   3. petition_signatures loses its `kind` column (every row left is a
--      petition signature) and gets back its plain "one signature per email"
--      rule.
--   4. A new write function, request_city(), is how the app adds a request.
--      sign_petition() still accepts kind 'city_request' and sends it to the
--      new table, so the code that is live right now keeps working whether
--      this runs before or after the merge.
--   5. city_request_count(), withdraw_petition_signature() and
--      purge_expired_signatures() now look at the right table(s).
--      city_request_tally() is new: per-request place name plus an md5
--      fingerprint of the email (enough to tell that two requests came from
--      one person, without handing over the address), for the daily
--      threshold-alert job. Service key only. petition_count() is granted to
--      the service key for the same job.
--
-- WHAT COULD GO WRONG
--
--   * This moves personal data between tables. It runs inside one transaction
--     (BEGIN ... COMMIT): if any step fails -- including the check that
--     "rows moved = rows removed = city requests before" -- nothing is changed
--     at all and you get an error message instead.
--   * While it runs (well under a second at current sizes) the petition table
--     is locked against new signatures, so a visitor signing at that exact
--     moment waits briefly rather than being lost.
--   * Dropping `kind` is not reversible by re-running anything, but nothing
--     is lost by it: after the move every remaining row is a petition
--     signature, so the column carries no information.
--   * The petition count shown on /petition will DROP by the number of city
--     requests. That is the correction, not a loss.
--
-- ORDER. Any time: before or after the dev -> main merge. The old routes call
-- sign_petition('city_request', ...), which this redirects; the new routes
-- call request_city(). Run it once.
--
-- Before running, to see what will move (and that migration 18's two indexes,
-- which this file drops by name, are there):
--   SELECT kind, count(*) FROM petition_signatures GROUP BY kind;
--   SELECT indexname FROM pg_indexes WHERE tablename = 'petition_signatures';
-- Afterwards:
--   SELECT count(*) FROM petition_signatures;   -- the petition rows
--   SELECT count(*) FROM city_requests;         -- the city_request rows

BEGIN;

-- Hold off new signatures and requests while rows move, so none arrives
-- between the copy and the delete. Reads (the public count) still work.
LOCK TABLE petition_signatures IN SHARE ROW EXCLUSIVE MODE;

-- ─── 1. The new table ───────────────────────────────────────────────────────

CREATE TABLE city_requests (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  -- Lowercased by the trigger below, so the uniqueness rule is case-blind.
  email             TEXT NOT NULL CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  -- Free text, exactly as typed (trimmed). Spelling variants are reconciled
  -- by the alert job (scripts/alerts/place_names.py), not rewritten here, so
  -- the row always shows what the person actually asked for.
  city              TEXT NOT NULL CHECK (length(btrim(city)) BETWEEN 1 AND 60),
  -- The consent text shown at the time, frozen per row (see migration 16).
  purpose           TEXT NOT NULL,
  -- Kept for rows moved from petition_signatures: some requesters were given
  -- this code before withdrawal moved to email (Nov 2026), and it must still
  -- work. New rows get one too, never shown.
  withdrawal_token  UUID NOT NULL DEFAULT gen_random_uuid(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Two years, unless withdrawn sooner. Same promise as the petition.
  expires_at        TIMESTAMPTZ NOT NULL DEFAULT now() + interval '2 years'
);

-- One request per person PER CITY: Indore and Nagpur are two requests,
-- Indore twice is one. Same rule migration 18 had, now on its own table.
CREATE UNIQUE INDEX city_requests_email_city_uniq
  ON city_requests (email, lower(btrim(city)));
CREATE UNIQUE INDEX city_requests_token_uniq ON city_requests (withdrawal_token);
CREATE INDEX city_requests_expires_idx ON city_requests (expires_at);
-- The public per-city count looks up by this expression.
CREATE INDEX city_requests_city_idx ON city_requests (lower(btrim(city)));

-- Same tidy-up on the way in as petition_signatures (trim name and city,
-- lowercase email). The function from migration 16 only touches those three
-- columns, which this table has under the same names, so it is reused rather
-- than copied.
CREATE TRIGGER on_city_request_normalise
  BEFORE INSERT OR UPDATE ON city_requests
  FOR EACH ROW
  EXECUTE FUNCTION normalise_petition_signature();

-- Row-level security on, and NO policies: the public key can neither read nor
-- write. All writes go through request_city() below.
ALTER TABLE city_requests ENABLE ROW LEVEL SECURITY;

-- Grants (Supabase no longer adds these automatically for new tables).
-- Visitors: nothing. The service key (scheduled jobs, never the browser):
-- read, and delete for removal requests.
REVOKE ALL ON city_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT, DELETE ON city_requests TO service_role;

COMMENT ON TABLE city_requests IS
  'Personal data. "Add my city" requests, moved out of petition_signatures by migration 28. No policies: unreadable and unwritable with the public key; writes via request_city(), public counts via city_request_count().';

-- ─── 2. Move the existing requests ──────────────────────────────────────────

DO $$
DECLARE
  before_count INTEGER;
  moved        INTEGER;
  removed      INTEGER;
BEGIN
  SELECT count(*) INTO before_count
  FROM petition_signatures WHERE kind = 'city_request';

  -- Every column carried over as-is, including created_at, expires_at and
  -- the frozen consent text.
  INSERT INTO city_requests
    (id, name, email, city, purpose, withdrawal_token, created_at, expires_at)
  SELECT id, name, email, city, purpose, withdrawal_token, created_at, expires_at
  FROM petition_signatures
  WHERE kind = 'city_request';
  GET DIAGNOSTICS moved = ROW_COUNT;

  DELETE FROM petition_signatures WHERE kind = 'city_request';
  GET DIAGNOSTICS removed = ROW_COUNT;

  -- If these disagree, RAISE undoes the whole file.
  IF moved <> before_count OR removed <> before_count THEN
    RAISE EXCEPTION 'city request move did not balance: % before, % copied, % removed',
      before_count, moved, removed;
  END IF;

  RAISE NOTICE 'Moved % city request(s) to city_requests.', moved;
END $$;

-- ─── 3. petition_signatures is petitions only again ─────────────────────────

DROP INDEX petition_signatures_city_request_uniq;
DROP INDEX petition_signatures_petition_email_uniq;
ALTER TABLE petition_signatures DROP CONSTRAINT petition_signatures_kind_check;
ALTER TABLE petition_signatures DROP COLUMN kind;

-- One signature per email, as migration 16 had it.
CREATE UNIQUE INDEX petition_signatures_email_uniq ON petition_signatures (email);

-- ─── 4. The write functions ─────────────────────────────────────────────────

-- The only way to add a city request. purpose, expiry, created_at and the
-- token are set HERE so a caller cannot choose them. The purpose text must
-- match CITY_REQUEST_PURPOSE in lib/api/petition.ts (tests/api/petition.test.ts
-- checks). Raises 23505 if this email already asked for this city.
CREATE FUNCTION request_city(p_name TEXT, p_email TEXT, p_city TEXT)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO city_requests (name, email, city, purpose)
  VALUES (
    p_name, p_email, p_city,
    'A request to add this city to the app. Counted publicly per city; email used only to tell this person when their city is added, and deleted with the request.'
  );
$$;

COMMENT ON FUNCTION request_city(TEXT, TEXT, TEXT) IS
  'The only way to add a city request. Sets purpose, expiry and token itself. Raises 23505 if that email already asked for that city.';

REVOKE ALL ON FUNCTION request_city(TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION request_city(TEXT, TEXT, TEXT) TO anon, authenticated;

-- sign_petition keeps its signature (the live code calls it), but a
-- 'city_request' now goes to the new table. The new app code only ever passes
-- 'petition'. CREATE OR REPLACE keeps migration 23's grants.
CREATE OR REPLACE FUNCTION sign_petition(
  p_kind          TEXT,
  p_name          TEXT,
  p_email         TEXT,
  p_city          TEXT,
  p_wants_updates BOOLEAN DEFAULT false
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  token UUID := gen_random_uuid();
BEGIN
  IF p_kind = 'city_request' THEN
    -- Kept for the routes deployed before migration 28.
    PERFORM request_city(p_name, p_email, p_city);
    RETURN NULL;
  ELSIF p_kind <> 'petition' THEN
    RAISE EXCEPTION 'unknown kind %', p_kind USING ERRCODE = '22023';
  END IF;

  INSERT INTO petition_signatures
    (name, email, city, wants_updates, purpose, withdrawal_token)
  VALUES (
    p_name, p_email, p_city,
    coalesce(p_wants_updates, false),
    'Support for building hyperlocal air quality measurement in India. Shown as an aggregate count publicly; name and city may be shown to funders in aggregate or anonymised form; email used only to contact signatories who opted in.',
    token
  );
  RETURN token;
END;
$$;

COMMENT ON FUNCTION sign_petition(TEXT, TEXT, TEXT, TEXT, BOOLEAN) IS
  'The only way to add a petition signature (p_kind = ''petition''). Sets purpose, expiry and withdrawal token itself. Raises 23505 if that email has already signed. p_kind = ''city_request'' is forwarded to request_city() for routes deployed before migration 28.';

-- ─── 5. Counts, withdrawal, retention, and the alert job's read ─────────────

-- Unchanged text; it now counts petition signatures only because that is all
-- the table holds.
CREATE OR REPLACE FUNCTION petition_count()
RETURNS INTEGER
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT count(*)::INTEGER FROM petition_signatures WHERE expires_at > now();
$$;

-- The threshold-alert job reads this with the service key. Migration 23
-- granted it to the public roles only, so say it explicitly.
GRANT EXECUTE ON FUNCTION petition_count() TO service_role;

-- Same matching as migration 18 (case- and space-blind), new table.
CREATE OR REPLACE FUNCTION city_request_count(p_city TEXT)
RETURNS INTEGER
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT count(*)::INTEGER
  FROM city_requests
  WHERE lower(btrim(city)) = lower(btrim(p_city))
    AND expires_at > now();
$$;

-- A withdrawal code may belong to either table.
CREATE OR REPLACE FUNCTION withdraw_petition_signature(token UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  removed INTEGER;
  removed_request INTEGER;
BEGIN
  DELETE FROM petition_signatures WHERE withdrawal_token = token;
  GET DIAGNOSTICS removed = ROW_COUNT;
  DELETE FROM city_requests WHERE withdrawal_token = token;
  GET DIAGNOSTICS removed_request = ROW_COUNT;
  RETURN removed + removed_request > 0;
END;
$$;

-- Retention for both tables, in one call.
CREATE OR REPLACE FUNCTION purge_expired_signatures()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  removed INTEGER;
  removed_requests INTEGER;
BEGIN
  DELETE FROM petition_signatures WHERE expires_at <= now();
  GET DIAGNOSTICS removed = ROW_COUNT;
  DELETE FROM city_requests WHERE expires_at <= now();
  GET DIAGNOSTICS removed_requests = ROW_COUNT;
  RETURN removed + removed_requests;
END;
$$;

-- For the daily threshold-alert job (scripts/alerts/threshold_alerts.py): one
-- row per live request, with the place as typed and an md5 fingerprint of the
-- email. The job needs to know that "Brahmapur" and "Berhampur, Odisha" came
-- from the same person so it does not count them twice -- but it does not need
-- the address, so the address never leaves the database. Service key only.
CREATE FUNCTION city_request_tally()
RETURNS TABLE (city TEXT, requester TEXT)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT r.city, md5(r.email)
  FROM city_requests r
  WHERE r.expires_at > now();
$$;

COMMENT ON FUNCTION city_request_tally() IS
  'Live city requests as (place as typed, md5 of email), for the threshold-alert job. No names or addresses. Service key only.';

REVOKE ALL ON FUNCTION city_request_tally() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION city_request_tally() TO service_role;

COMMIT;
