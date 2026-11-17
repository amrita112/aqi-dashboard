-- 29. City requests are counted per PLACE, not per exact spelling.
--
-- WHY. The form's live count ("12 people have asked for this") came from
-- city_request_count(), which matched the name exactly as typed (ignoring
-- only case and outer spaces). "Brahmapur", "Brahmapur, Odisha" and
-- "Berhampur" were three separate counts of a few each, while the alert job
-- (scripts/alerts/place_names.py) already treated them as one place. The
-- public number and the milestone alert disagreed.
--
-- THE RULE, AND WHERE IT LIVES. A place name is reduced to a KEY: Unicode-
-- normalise, lowercase, cut at the first comma or "(", punctuation -> spaces,
-- collapse spaces. "Brahmapur, Odisha" -> "brahmapur". Spelling variants
-- ("berhampur" -> "brahmapur") come from lib/place-aliases.json. That rule is
-- defined in the app (lib/place-names.ts) and in the alert job
-- (scripts/alerts/place_names.py), both tested against one shared cases file
-- (tests/fixtures/place_names/cases.json). The database does not decide what
-- a key is: the app computes it and passes it in.
--
--   * The key is STORED on each row (place_key) so counting is a plain,
--     indexed lookup -- no normalising every row on every keystroke.
--   * Aliases are NOT stored. The app turns what was typed into the set of
--     keys that mean the same place ("berhampur" -> {behrampur, berhampur,
--     brahmapur, brahmpur}) and asks for the count over that set. So adding a
--     line to the alias file changes the counts at once, with no database
--     change.
--
-- WHAT CHANGES
--
--   1. city_requests gets place_key, filled in for every existing row (the
--      backfill, below) and NOT NULL from then on.
--   2. request_city() takes the key as a fourth argument. It is optional, so
--      the code live right now (which calls sign_petition(), which calls
--      request_city() with three arguments) keeps working; when no key is
--      given, the database computes one itself (see "the fallback" below).
--   3. city_request_count_for(keys) is the new public count: how many
--      DIFFERENT PEOPLE (distinct emails) have a live request whose key is in
--      the set. Someone who typed both "Brahmapur" and "Berhampur" counts
--      once. It returns one number; it never returns names, emails or the
--      list of places people typed.
--   4. city_request_tally() (the alert job's read, service key only) also
--      returns place_key, so the alert counts exactly what the form shows.
--
-- THE FALLBACK. Two things need a key without the app: the backfill of rows
-- that already exist, and requests arriving through the old code before the
-- dev -> main merge. For those only, city_place_key_fallback() below applies
-- the same rule in SQL. It gives the same key as the app on every name in
-- the shared cases file, Latin and Indian scripts alike (checked on a local
-- Postgres), except two non-Indian lowercase quirks (Turkish dotted "İ",
-- Greek final sigma). Postgres's idea of "letter" outside Latin depends on
-- the server's locale, so rare symbols could still be read differently; the file
-- reports how many non-ASCII rows it backfilled, and the alert job prints a
-- warning with a count (never the names) if any stored key disagrees with
-- the Python rule.
--
-- PRIVACY. Unchanged: the public key can still neither read nor write
-- city_requests. It can call request_city() and city_request_count_for(),
-- both SECURITY DEFINER (they run with the table owner's rights, so they can
-- see the table on the caller's behalf, but only return what they are written
-- to return). A visitor can learn "how many people asked for the place I
-- typed" -- which the form already showed -- and nothing else.
--
-- WHAT COULD GO WRONG
--
--   * The backfill rewrites one new column on every city request. It runs in
--     one transaction: if anything fails, nothing is changed.
--   * Uniqueness is unchanged: still one request per email per spelling. A
--     person who asks for "Brahmapur" and then "Berhampur" gets two rows, but
--     both counts (public and alert) count them once.
--   * The OLD route code (on main until the merge) still calls
--     city_request_count(), the exact-spelling count, which this file leaves
--     as it was. It can be dropped in a later migration once the merge is
--     live.
--
-- ORDER. Run this BEFORE merging dev -> main. The new route calls
-- request_city() with four arguments and city_request_count_for(), which do
-- not exist until this has run; the old route keeps working after it. Run
-- it once.
--
-- Afterwards, to see the keys:
--   SELECT place_key, city, count(*) FROM city_requests GROUP BY 1, 2 ORDER BY 1;

BEGIN;

-- Hold off new requests while the column is added and filled. Reads (the
-- public count) still work.
LOCK TABLE city_requests IN SHARE ROW EXCLUSIVE MODE;

-- ─── 1. The fallback rule, in SQL ───────────────────────────────────────────

-- Same steps as lib/place-names.ts basicPlace(), in Postgres terms:
--   normalize(..., NFKC)          Unicode normalisation (full-width -> plain)
--   lower()                       lowercase
--   regexp_replace '[,(].*$'      cut at the first comma or "(" ('.' in
--                                 Postgres regexes also matches line breaks)
--   regexp_replace '[^...]+'      anything not a letter, digit or mark -> a
--                                 space. [:alnum:] is letters and digits.
--                                 Marks (the vowel signs and viramas of Indian
--                                 scripts) are not "alnum" on every server, so
--                                 two ranges are listed explicitly: combining
--                                 accents (U+0300-036F) and the Indian-script
--                                 blocks Devanagari..Sinhala (U+0900-0DFF),
--                                 leaving out the danda and double danda
--                                 (U+0964-0965, the Indic full stops).
--   btrim                         no leading/trailing spaces
-- Used ONLY when the app did not pass a key (backfill, old code).
CREATE FUNCTION city_place_key_fallback(p_city TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT btrim(
    regexp_replace(
      regexp_replace(lower(normalize(coalesce(p_city, ''), NFKC)), '[,(].*$', ''),
      '[^[:alnum:]\u0300-\u036F\u0900-\u0963\u0966-\u0DFF]+', ' ', 'g'
    )
  );
$$;

COMMENT ON FUNCTION city_place_key_fallback(TEXT) IS
  'SQL copy of the place-key rule, for rows written without a key (the migration 29 backfill, and routes deployed before it). The app computes keys itself: lib/place-names.ts.';

-- Only the database itself calls this (the trigger below runs as the table
-- owner), so nobody else needs it.
REVOKE ALL ON FUNCTION city_place_key_fallback(TEXT) FROM PUBLIC, anon, authenticated;

-- ─── 2. The column, backfilled ──────────────────────────────────────────────

ALTER TABLE city_requests ADD COLUMN place_key TEXT;

DO $$
DECLARE
  total      INTEGER;
  filled     INTEGER;
  non_latin  INTEGER;
BEGIN
  SELECT count(*) INTO total FROM city_requests;

  UPDATE city_requests SET place_key = city_place_key_fallback(city);
  GET DIAGNOSTICS filled = ROW_COUNT;

  IF filled <> total THEN
    RAISE EXCEPTION 'place_key backfill did not cover every row: % rows, % filled', total, filled;
  END IF;

  -- Names with characters outside plain ASCII are the ones the SQL rule
  -- might read differently from the app's (see THE FALLBACK above).
  SELECT count(*) INTO non_latin FROM city_requests WHERE city !~ '^[ -~]*$';

  RAISE NOTICE 'Backfilled place_key on % request(s); % contain non-ASCII characters.', filled, non_latin;
END $$;

-- Every row has a key from now on (the trigger below fills any the caller
-- leaves out). 200 rather than 60 because Unicode normalisation can lengthen
-- a name slightly. An empty key is allowed: a "city" of only punctuation has
-- nothing left, and is simply never counted.
ALTER TABLE city_requests
  ALTER COLUMN place_key SET NOT NULL,
  ADD CONSTRAINT city_requests_place_key_length CHECK (length(place_key) <= 200);

-- The public count looks up by key; the old exact-spelling index stays for
-- the old count until that is dropped.
CREATE INDEX city_requests_place_key_idx ON city_requests (place_key);

COMMENT ON COLUMN city_requests.place_key IS
  'The place as a matching key (lib/place-names.ts basicPlace): "Brahmapur, Odisha" -> "brahmapur". Aliases are applied when counting, not stored here.';

-- If a row arrives without a key (old code), or someone edits `city` in the
-- table editor without touching the key, compute it in SQL so the key never
-- goes missing or stale.
CREATE FUNCTION city_request_fill_place_key()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.place_key IS NULL
     OR (TG_OP = 'UPDATE' AND NEW.city IS DISTINCT FROM OLD.city
         AND NEW.place_key IS NOT DISTINCT FROM OLD.place_key) THEN
    NEW.place_key := city_place_key_fallback(NEW.city);
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION city_request_fill_place_key() FROM PUBLIC, anon, authenticated;

-- Runs after on_city_request_normalise (triggers fire in name order), so it
-- sees the trimmed city.
CREATE TRIGGER on_city_request_place_key
  BEFORE INSERT OR UPDATE ON city_requests
  FOR EACH ROW
  EXECUTE FUNCTION city_request_fill_place_key();

-- ─── 3. Writing: request_city takes the key ─────────────────────────────────

-- Replaced rather than overloaded: two request_city functions would make a
-- three-argument call ambiguous. sign_petition() (migration 28) calls it with
-- three arguments, which this version still accepts.
DROP FUNCTION request_city(TEXT, TEXT, TEXT);

-- p_place_key: what lib/place-names.ts basicPlace() made of p_city. Omitted
-- or NULL -> the trigger computes it. The purpose text must match
-- CITY_REQUEST_PURPOSE in lib/api/petition.ts (tests/api/petition.test.ts
-- checks). Raises 23505 if this email already asked for this spelling.
CREATE FUNCTION request_city(
  p_name      TEXT,
  p_email     TEXT,
  p_city      TEXT,
  p_place_key TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO city_requests (name, email, city, place_key, purpose)
  VALUES (
    p_name, p_email, p_city, p_place_key,
    'A request to add this city to the app. Counted publicly per city; email used only to tell this person when their city is added, and deleted with the request.'
  );
$$;

COMMENT ON FUNCTION request_city(TEXT, TEXT, TEXT, TEXT) IS
  'The only way to add a city request. Sets purpose, expiry and token itself; p_place_key from lib/place-names.ts (computed in SQL if omitted). Raises 23505 if that email already asked for that spelling.';

REVOKE ALL ON FUNCTION request_city(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION request_city(TEXT, TEXT, TEXT, TEXT) TO anon, authenticated;

-- ─── 4. The public count, per place ─────────────────────────────────────────

-- How many different people (distinct emails) have a live request under any
-- of these keys. The app passes every key that means the place typed (the
-- canonical name and its aliases). At most 50 keys per call: no place has
-- anywhere near that many spellings, and the cap stops one call from being
-- used to sweep the table.
CREATE FUNCTION city_request_count_for(p_keys TEXT[])
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
DECLARE
  people INTEGER;
BEGIN
  IF coalesce(cardinality(p_keys), 0) > 50 THEN
    RAISE EXCEPTION 'at most 50 keys per call' USING ERRCODE = '22023';
  END IF;

  SELECT count(DISTINCT email)::INTEGER INTO people
  FROM city_requests
  WHERE place_key = ANY (p_keys)
    AND place_key <> ''
    AND expires_at > now();

  RETURN people;
END;
$$;

COMMENT ON FUNCTION city_request_count_for(TEXT[]) IS
  'Public count: distinct people with a live city request under any of these place keys (lib/place-names.ts placeKeyGroup). Returns a number only.';

REVOKE ALL ON FUNCTION city_request_count_for(TEXT[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION city_request_count_for(TEXT[]) TO anon, authenticated, service_role;

-- ─── 5. The alert job's read also returns the key ───────────────────────────

-- Its columns change, which CREATE OR REPLACE cannot do, so drop and create
-- (and grant again). Still no names or addresses: place as typed, its key,
-- and an md5 fingerprint of the email.
DROP FUNCTION city_request_tally();

CREATE FUNCTION city_request_tally()
RETURNS TABLE (city TEXT, place_key TEXT, requester TEXT)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT r.city, r.place_key, md5(r.email)
  FROM city_requests r
  WHERE r.expires_at > now();
$$;

COMMENT ON FUNCTION city_request_tally() IS
  'Live city requests as (place as typed, place_key, md5 of email), for the threshold-alert job. No names or addresses. Service key only.';

REVOKE ALL ON FUNCTION city_request_tally() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION city_request_tally() TO service_role;

COMMIT;
