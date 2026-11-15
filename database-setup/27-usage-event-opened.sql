-- 27. Count opens of the installed app.
--
-- WHY. Installs are counted, but nothing showed whether people OPEN the app
-- afterwards. Vercel cannot tell: it forgets a visitor every day by design, and
-- usage_events carries no identifier, also by design.
--
-- WHAT. A new event name, 'opened': recorded when the app is launched from the
-- home screen, at most once per device per day. Its detail is only how long
-- ago that phone installed the app -- d0, d1_7, d8_30, d31_plus, or the same
-- with a "seen_" prefix when the install date is not known and the first
-- home-screen open is used instead (lib/launch.ts). The install date itself
-- stays on the phone. The existing detail CHECK (short lowercase token)
-- already fits these.
--
-- ORDER. Run BEFORE the next merge. Until it runs, 'opened' events are refused
-- by the CHECK and simply lost; nothing else is affected.
--
-- Reading it, e.g. opens per week by time since install:
--   SELECT date_trunc('week', created_at AT TIME ZONE 'Asia/Kolkata') AS week,
--          detail, count(*)
--   FROM usage_events WHERE name = 'opened'
--   GROUP BY 1, 2 ORDER BY 1, 2;

BEGIN;

ALTER TABLE usage_events DROP CONSTRAINT usage_events_name_check;
ALTER TABLE usage_events ADD CONSTRAINT usage_events_name_check
  CHECK (name IN ('installed', 'question', 'question_failed', 'opened'));

COMMENT ON COLUMN usage_events.name IS
  'installed = the app was added to a home screen. question = an AI question was answered. question_failed = the AI box declined or errored. opened = the installed app was opened from the home screen (once per device per day).';
COMMENT ON COLUMN usage_events.detail IS
  'For question: the tool that produced the answer, or none. For question_failed: the reason. For installed: how it was installed (prompt or browser). For opened: time since install -- d0, d1_7, d8_30, d31_plus; prefixed seen_ when measured from the first home-screen open because the install date is unknown.';

COMMIT;
