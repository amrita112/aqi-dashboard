-- 24. Visitors can no longer write to tables directly. (Step 2 of 2.)
--
-- WHY (Nov 2026 audit, §2.2, §2.3). See migration 23 for the full story: the
-- app's server uses the PUBLIC key, so anyone holding it could insert into
-- these tables directly, skipping the routes' checks -- choosing a petition
-- signature's expiry, consent text and withdrawal token, adding stations to
-- the map, or planting a "current reading" on an official station.
--
-- After this, the only ways in are the functions from migration 23
-- (sign_petition, record_usage_event, record_client_error), and the scheduled
-- jobs, which use the service key and are unaffected.
--
-- ORDER. Run AFTER the merge has deployed: the routes that were live before it
-- insert directly, and would be refused. If a step here fails, the whole file
-- is rolled back (BEGIN ... COMMIT), so nothing is half-applied.

BEGIN;

DROP POLICY "Users can insert their own readings" ON readings;
DROP POLICY "Users can update their own readings" ON readings;
DROP POLICY "Users can delete their own readings" ON readings;
DROP POLICY "Authenticated users can register monitors" ON monitors;
DROP POLICY petition_signatures_public_insert ON petition_signatures;
DROP POLICY "anyone can record an event" ON usage_events;
DROP POLICY "anyone can report an error" ON client_errors;

-- Belt and braces: with no policy RLS already refuses, but a later policy
-- added by mistake should not silently reopen these.
REVOKE INSERT, UPDATE, DELETE ON readings, monitors, petition_signatures,
  usage_events, client_errors FROM anon, authenticated;

COMMIT;
