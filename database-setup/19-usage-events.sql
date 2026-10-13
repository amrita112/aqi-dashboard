-- 19. Counting how the app is used, without recording who used it or what they asked.
--
-- WHY THIS EXISTS. Vercel Web Analytics gives page views on the free tier but
-- puts CUSTOM EVENTS behind Pro, so `track()` in lib/analytics.ts has been a
-- silent no-op: it does not error, it simply drops everything. Three questions
-- were going unanswered because of it:
--
--   how many people actually INSTALL the app, rather than bookmarking a tab
--   which of the seven AI tools answer real questions
--   how often, and why, the AI box declines to answer
--
-- The first is the one that decides whether the PWA framing is working at all.
-- There is no download to count: `appinstalled` is the only signal a web app
-- ever gets, and it fires once, in the browser, and is gone.
--
-- WHAT THIS TABLE DELIBERATELY CANNOT HOLD. No question text. No place, no
-- coordinates, no city. No IP address, no session or device identifier, no
-- user agent. Nothing that could be joined back to a person or to what they
-- were worried about. Every column is a short enumerated token checked against
-- a fixed list below, so there is no free-text field for anything to leak
-- into even by accident.
--
-- That is a stricter rule than the law requires and it is the point: this app
-- argues that air quality data should be public and that personal data should
-- not, and "is the air bad where my daughter goes to school" is exactly the
-- kind of sentence that would otherwise accumulate in a log.
--
-- The cost of that strictness, stated so nobody goes looking for it later: you
-- can never ask "how many DIFFERENT people installed" or "did the person who
-- asked X come back". Only totals over a window. That is the trade.

CREATE TABLE IF NOT EXISTS usage_events (
  id          BIGSERIAL PRIMARY KEY,
  -- What happened. Checked, not free text.
  name        TEXT NOT NULL,
  -- Secondary token: the tool that answered, or the reason we declined.
  detail      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- THE ALLOWLIST IS IN THE DATABASE, not only in the API route. This table is
-- written by a public endpoint using the anon key — the same key that ships to
-- every browser — so anyone can POST to it. The route validates, and the route
-- is one deploy away from being wrong. A CHECK constraint is the thing that
-- cannot be bypassed by a bug or by someone calling the endpoint directly.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'usage_events_name_check') THEN
    ALTER TABLE usage_events ADD CONSTRAINT usage_events_name_check
      CHECK (name IN ('installed', 'question', 'question_failed'));
  END IF;

  -- Length-capped rather than enumerated: tool names come from lib/ai/tools.ts
  -- and will change as tools are added, and a migration per tool would be a
  -- migration nobody runs. The cap is what stops this being a text field.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'usage_events_detail_check') THEN
    ALTER TABLE usage_events ADD CONSTRAINT usage_events_detail_check
      CHECK (detail IS NULL OR (LENGTH(detail) <= 40 AND detail ~ '^[a-z0-9_]+$'));
  END IF;
END $$;

COMMENT ON TABLE usage_events IS
  'Anonymous usage counts. No question text, no location, no identifier of any kind — only an enumerated event name and a short token. Totals over a window are the only thing it can answer.';
COMMENT ON COLUMN usage_events.name IS
  'installed = the app was added to a home screen. question = an AI question was answered. question_failed = the AI box declined or errored.';
COMMENT ON COLUMN usage_events.detail IS
  'For question: the tool that produced the answer, or none. For question_failed: the reason. For installed: how it was installed (prompt or browser).';
COMMENT ON COLUMN usage_events.created_at IS
  'UTC instant. Group by date at IST (created_at AT TIME ZONE ''Asia/Kolkata'') to get Indian calendar days.';

-- Every query against this table is "how many of X in the last N days".
CREATE INDEX IF NOT EXISTS usage_events_created_idx ON usage_events (created_at DESC);
CREATE INDEX IF NOT EXISTS usage_events_name_created_idx ON usage_events (name, created_at DESC);

-- SAME SHAPE AS petition_signatures: INSERT allowed, SELECT impossible.
--
-- Not because these rows are sensitive — they are built not to be — but
-- because a readable table is one schema change away from being a sensitive
-- one, and because nothing in the app ever needs to read them back. Counts are
-- read in the Supabase SQL editor, which authenticates as you, or by a job
-- holding the service-role key. The browser can only ever add a row.
ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anyone can record an event" ON usage_events;
CREATE POLICY "anyone can record an event" ON usage_events
  FOR INSERT TO anon, authenticated
  WITH CHECK (true);

-- No SELECT, UPDATE or DELETE policy, on purpose. Do not add one.

-- RETENTION. These are counts, and a count stops being interesting long before
-- it stops taking up space. Ninety days answers every question anyone has
-- actually asked of this data and keeps the table at a few MB against a 500 MB
-- budget that is already about a third used.
CREATE OR REPLACE FUNCTION purge_old_usage_events()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  removed INTEGER;
BEGIN
  DELETE FROM usage_events WHERE created_at < NOW() - INTERVAL '90 days';
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END $$;

COMMENT ON FUNCTION purge_old_usage_events() IS
  'Drops usage events older than 90 days. Called by the weekly prune-raw job.';
