-- 18. "Add my city" requests.
--
-- WHY THIS TABLE AND NOT A NEW ONE. A city request has the same shape as a
-- petition signature — a name, an email, a city, a purpose and a withdrawal
-- token — and the same obligations under the DPDP Act. Duplicating the table
-- would duplicate the retention trigger, the withdrawal function and the RLS
-- policies, and the second copy would be the one that drifts. So requests live
-- in petition_signatures, distinguished by `kind`.
--
-- The `city` column was already free text rather than a foreign key, with the
-- comment "someone in a city we do not yet cover is exactly the person whose
-- support is worth having". This is that person.

ALTER TABLE petition_signatures
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'petition';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'petition_signatures_kind_check'
  ) THEN
    ALTER TABLE petition_signatures
      ADD CONSTRAINT petition_signatures_kind_check
      CHECK (kind IN ('petition', 'city_request'));
  END IF;
END $$;

COMMENT ON COLUMN petition_signatures.kind IS
  'petition = support for hyperlocal measurement. city_request = asking for this city to be covered. Separate counts, one table, one set of privacy guarantees.';

-- Counting by city is the whole point: fifty requests for one place is a
-- commitment we made publicly, so it has to be countable without exposing who
-- asked. SECURITY DEFINER for the same reason petition_count() is: the table
-- has no SELECT policy at all, and this returns an integer and nothing else.
CREATE OR REPLACE FUNCTION city_request_count(p_city TEXT)
RETURNS INTEGER
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT count(*)::INTEGER
  FROM petition_signatures
  WHERE kind = 'city_request'
    AND lower(btrim(city)) = lower(btrim(p_city))
    -- Withdrawal is a HARD delete here, so there is no withdrawn flag to test:
    -- a withdrawn row is simply gone. Expiry is the only thing to exclude, and
    -- only because the sweeper runs on a schedule rather than continuously.
    AND expires_at > now();
$$;

COMMENT ON FUNCTION city_request_count(TEXT) IS
  'How many people have asked for this city, case- and whitespace-insensitively. Returns a count and nothing else; the rows themselves stay unreadable.';

REVOKE ALL ON FUNCTION city_request_count(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION city_request_count(TEXT) TO anon, authenticated;

-- ─── The uniqueness rule has to change, or this feature cannot work ─────────
--
-- Migration 16 made email unique across the WHOLE table, enforcing "one person
-- signs the petition once". Sharing the table breaks that in two ways:
--
--   someone who signed the petition could not then request a city
--   nobody could request a second city
--
-- Both are wrong, and both would surface as a bare constraint violation. So
-- the single index becomes two partial ones, each saying what it actually
-- means:

DROP INDEX IF EXISTS petition_signatures_email_uniq;

-- One signature per person, unchanged in effect for petition rows.
CREATE UNIQUE INDEX IF NOT EXISTS petition_signatures_petition_email_uniq
  ON petition_signatures (email)
  WHERE kind = 'petition';

-- One request per person PER CITY: asking for Indore and Nagpur is two
-- legitimate requests; asking for Indore twice is one.
CREATE UNIQUE INDEX IF NOT EXISTS petition_signatures_city_request_uniq
  ON petition_signatures (email, lower(btrim(city)))
  WHERE kind = 'city_request';

-- The existing INSERT policy already covers these rows: same table, same
-- "anyone may add, nobody may read" rule.
