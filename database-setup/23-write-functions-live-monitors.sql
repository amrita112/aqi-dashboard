-- 23. Database functions for the app's writes; "nearest stations" means live
--     stations. (Step 1 of 2 -- migration 24 then removes direct writes.)
--
-- WHY (Nov 2026 audit, §2.2, §2.3, §2.6, §1.2).
--
-- The app's server talks to Supabase with the PUBLIC (anon) key, so every
-- write a route makes was also possible for anyone holding that key, by
-- calling the database directly and skipping the route's checks:
--
--   petition_signatures  anyone could insert, choosing their own expires_at
--                        (defeating the two-year retention), purpose (a forged
--                        consent text) and withdrawal token, with no rate limit.
--   usage_events,        anyone could insert, bypassing the route's rate
--   client_errors        limit and choosing created_at.
--   monitors             any signed-up user could add a station, which would
--                        then appear on the map, in the picker and in AI answers.
--   readings             any signed-up user could add a reading pointing at an
--                        official station, which became its "current" reading.
--
-- The app has no sign-in screen, so nobody legitimately uses the last two.
--
-- WHAT CHANGES HERE
--
--   1. (Migration 24, after the new routes are live: direct inserts removed
--      from all five tables.)
--   2. The three tables the app does write to get a database function each,
--      which sets every sensitive column itself: sign_petition(),
--      record_usage_event(), record_client_error(). The routes call these.
--   3. Housekeeping functions (purge_*, database_size_report) can no longer
--      be called with the public key. The scheduled jobs use the service key,
--      which is unaffected.
--   4. nearest_monitors() returns only LIVE official stations: not disabled,
--      and with a rolled-up day in the last 14 days. Before, "the 3 nearest
--      stations" could be one live station and two silent ones.
--
-- ORDER. Run this BEFORE the merge: it only adds functions and changes the
-- station search, so the code currently live keeps working, and the new routes
-- find their functions waiting. Run 24 AFTER the merge has deployed.
--
-- Existing tables, so no table GRANTs are needed; the new functions get
-- explicit EXECUTE grants below.

BEGIN;

-- ─── 2. The writes the app makes, as functions ──────────────────────────────

-- Petition signatures and city requests. purpose, expires_at, created_at and
-- the withdrawal token are set HERE, so a caller cannot choose them. The
-- purpose texts must match lib/api/petition.ts (the text shown on screen);
-- tests/api/petition.test.ts checks that they do.
CREATE FUNCTION sign_petition(
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
  IF p_kind NOT IN ('petition', 'city_request') THEN
    RAISE EXCEPTION 'unknown kind %', p_kind USING ERRCODE = '22023';
  END IF;
  INSERT INTO petition_signatures
    (kind, name, email, city, wants_updates, purpose, withdrawal_token)
  VALUES (
    p_kind, p_name, p_email, p_city,
    -- A city request is not a subscription to anything else.
    CASE WHEN p_kind = 'petition' THEN coalesce(p_wants_updates, false) ELSE false END,
    CASE p_kind
      WHEN 'petition' THEN 'Support for building hyperlocal air quality measurement in India. Shown as an aggregate count publicly; name and city may be shown to funders in aggregate or anonymised form; email used only to contact signatories who opted in.'
      ELSE 'A request to add this city to the app. Counted publicly per city; email used only to tell this person when their city is added, and deleted with the request.'
    END,
    token
  );
  -- Returned to the signatory once; it is never readable again.
  RETURN token;
END;
$$;

COMMENT ON FUNCTION sign_petition(TEXT, TEXT, TEXT, TEXT, BOOLEAN) IS
  'The only way to add a petition signature or city request. Sets purpose, expiry and withdrawal token itself. Raises 23505 if that email has already signed this kind.';

-- Anonymous usage counts. The table's own CHECKs limit name and detail.
CREATE FUNCTION record_usage_event(p_name TEXT, p_detail TEXT DEFAULT NULL)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO usage_events (name, detail) VALUES (p_name, p_detail);
$$;

-- Browser errors. The query string is stripped HERE as well as in the route:
-- this is the place that can guarantee it.
CREATE FUNCTION record_client_error(
  p_message  TEXT,
  p_stack    TEXT DEFAULT NULL,
  p_pathname TEXT DEFAULT NULL,
  p_browser  TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO client_errors (message, stack, pathname, browser)
  VALUES (
    left(p_message, 300),
    left(p_stack, 1000),
    left(split_part(split_part(p_pathname, '?', 1), '#', 1), 120),
    left(p_browser, 40)
  );
$$;

REVOKE ALL ON FUNCTION sign_petition(TEXT, TEXT, TEXT, TEXT, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION record_usage_event(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION record_client_error(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sign_petition(TEXT, TEXT, TEXT, TEXT, BOOLEAN) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION record_usage_event(TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION record_client_error(TEXT, TEXT, TEXT, TEXT) TO anon, authenticated;

-- ─── 3. Housekeeping functions: service key only ────────────────────────────

REVOKE ALL ON FUNCTION purge_expired_signatures() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION purge_old_usage_events() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION purge_old_client_errors() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION database_size_report() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION purge_expired_signatures() TO service_role;
GRANT EXECUTE ON FUNCTION purge_old_usage_events() TO service_role;
GRANT EXECUTE ON FUNCTION purge_old_client_errors() TO service_role;
GRANT EXECUTE ON FUNCTION database_size_report() TO service_role;

-- The public read-only functions, granted explicitly rather than inherited.
REVOKE ALL ON FUNCTION petition_count() FROM PUBLIC;
REVOKE ALL ON FUNCTION withdraw_petition_signature(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION petition_count() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION withdraw_petition_signature(UUID) TO anon, authenticated;

-- ─── 4. Nearest LIVE stations ───────────────────────────────────────────────

CREATE OR REPLACE FUNCTION nearest_monitors(
  lat        FLOAT8,
  lng        FLOAT8,
  k          INTEGER DEFAULT 5,
  max_km     FLOAT8  DEFAULT 25,
  want_city  TEXT    DEFAULT NULL
)
RETURNS TABLE (
  monitor_id  UUID,
  name        TEXT,
  city        TEXT,
  latitude    DOUBLE PRECISION,
  longitude   DOUBLE PRECISION,
  distance_km DOUBLE PRECISION
) AS $$
BEGIN
  RETURN QUERY
  SELECT m.id, m.name, m.city, m.latitude, m.longitude,
         ST_Distance(m.location,
                     ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography) / 1000.0
  FROM monitors m
  WHERE m.location IS NOT NULL
    AND (want_city IS NULL OR m.city = want_city)
    -- Official stations only, and not retired.
    AND m.serial_number LIKE 'openaq:%'
    AND m.disabled_at IS NULL
    -- LIVE: a rolled-up OpenAQ day in the last 14 days (the forecast's own
    -- lookback). A station silent for longer has nothing current to add, and
    -- counting it as one of "the 3 nearest" pushed a live one out. Uses the
    -- readings_daily primary key (monitor_id, ...), so it is an index lookup.
    AND EXISTS (
      SELECT 1 FROM readings_daily d
      WHERE d.monitor_id = m.id
        AND d.source = 'openaq'
        AND d.date >= (now() AT TIME ZONE 'Asia/Kolkata')::date - 14
    )
    AND ST_DWithin(m.location,
                   ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography,
                   max_km * 1000.0)
  ORDER BY m.location <-> ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography
  LIMIT k;
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION nearest_monitors(FLOAT8, FLOAT8, INTEGER, FLOAT8, TEXT) IS
  'The k nearest LIVE official stations within max_km: not disabled, with an OpenAQ day in readings_daily in the last 14 IST days.';

COMMIT;
