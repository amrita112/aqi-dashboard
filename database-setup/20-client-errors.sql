-- 20. What breaks in other people's browsers.
--
-- WHY. Vercel's logs catch errors on the server. Nothing catches the ones that
-- happen on a phone in Pune: a chart that throws on an empty series, a browser
-- without some API we assumed, a bad deploy that only breaks on iOS. Before
-- this, the only way to learn about those was for someone to mention it — and
-- most people do not mention it, they just stop opening the app.
--
-- WHY NOT SENTRY, which is the obvious answer and has a free tier that would
-- work. Two reasons, neither absolute:
--
--   It would be a third party receiving a stream of what goes wrong on users'
--   devices, in an app whose privacy page currently names exactly one external
--   recipient and explains it. Adding a second needs to be worth it.
--
--   The free tier is a business decision someone else can revisit, and this
--   project's hard constraint is that it runs on free tiers permanently.
--
-- What is given up by rolling our own, stated plainly so nobody is surprised:
-- no source maps, so stacks are minified; no grouping of duplicates; no alert
-- when something starts failing. This answers "did anything break, where, and
-- how often", and that is all. If the volume ever justifies real tooling,
-- Sentry is the upgrade and this table is the thing it replaces.

CREATE TABLE IF NOT EXISTS client_errors (
  id          BIGSERIAL PRIMARY KEY,
  -- The error's own message, truncated. See the length cap below.
  message     TEXT NOT NULL,
  -- Minified and therefore mostly useful for telling two errors apart.
  stack       TEXT,
  -- PATHNAME ONLY, never the full URL: a query string is the obvious place
  -- for something personal to end up, and no route in this app needs one.
  pathname    TEXT,
  -- Coarse browser family, for "only on iOS" questions. Not the user agent,
  -- which is long enough to help identify a device.
  browser     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- LENGTH CAPS ARE THE PRIVACY CONTROL HERE, and they are imperfect on purpose.
-- Unlike usage_events, this table cannot use an allowlist: an error message is
-- free text by nature, and the whole point is to read the ones we did not
-- anticipate. So a message could in principle contain something a person
-- typed, if some future code throws with user input in the message.
--
-- Mitigated rather than solved: the caps bound how much can arrive, the client
-- never sends query strings, and the app's own code does not put user input in
-- error messages. Worth re-reading if that ever changes.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'client_errors_sizes') THEN
    ALTER TABLE client_errors ADD CONSTRAINT client_errors_sizes CHECK (
      LENGTH(message) <= 300
      AND (stack IS NULL OR LENGTH(stack) <= 1000)
      AND (pathname IS NULL OR LENGTH(pathname) <= 120)
      AND (browser IS NULL OR LENGTH(browser) <= 40)
    );
  END IF;
END $$;

COMMENT ON TABLE client_errors IS
  'Errors from users browsers. Pathname only, never query strings; no identifier of any kind. Pruned after 30 days.';
COMMENT ON COLUMN client_errors.pathname IS
  'Route only, e.g. /trends. Never the full URL — a query string is where personal data would leak.';

CREATE INDEX IF NOT EXISTS client_errors_created_idx ON client_errors (created_at DESC);

-- Same shape as usage_events and petition_signatures: writable by the browser,
-- readable by nobody through the app. Read these in the SQL editor.
ALTER TABLE client_errors ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anyone can report an error" ON client_errors;
CREATE POLICY "anyone can report an error" ON client_errors
  FOR INSERT TO anon, authenticated
  WITH CHECK (true);

-- No SELECT, UPDATE or DELETE policy, on purpose. Do not add one.

-- Shorter retention than usage_events: an error is worth acting on this week
-- and is archaeology next month, and this table holds free text where that one
-- holds enumerated tokens.
CREATE OR REPLACE FUNCTION purge_old_client_errors()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  removed INTEGER;
BEGIN
  DELETE FROM client_errors WHERE created_at < NOW() - INTERVAL '30 days';
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END $$;

COMMENT ON FUNCTION purge_old_client_errors() IS
  'Drops client errors older than 30 days. Called by the weekly prune-raw job.';
