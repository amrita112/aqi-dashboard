-- =============================================================================
-- Migration: petition signatures
-- =============================================================================
-- The first table in this project that holds PERSONAL DATA, and it is therefore
-- the first one whose row-level security is the opposite of everything else.
--
-- Every other table here is world-readable on purpose: air quality is public
-- information and the anon key is shipped to the browser, so `SELECT USING
-- (true)` costs nothing. A list of named people who signed a petition is not
-- public information. If this table were readable with the anon key, anyone who
-- opened the site could download every signatory's name, email and city.
--
-- So: INSERT is allowed for anyone, SELECT is allowed for NOBODY. Not even the
-- signatory reads their own row back. The only way to see the contents is the
-- service_role key, which lives on the server and in the ingest scripts.
--
-- The public count comes from petition_count(), a SECURITY DEFINER function
-- that returns an integer and nothing else.
--
-- ─── India's DPDP Act, in the schema rather than in a policy document ────────
--
-- Collecting a name and an email makes this personal data under the Digital
-- Personal Data Protection Act 2023. Three obligations are met structurally
-- here so they cannot be forgotten later:
--
--   PURPOSE     `purpose` is stamped on every row with the reason the data was
--               collected. If the purpose ever changes, existing rows still
--               record what their signatory actually agreed to.
--   RETENTION   `expires_at` is set at insert. Rows past it are deleted by the
--               cleanup below; a signature is not kept forever by default.
--   WITHDRAWAL  `withdrawal_token` is generated per row and returned to the
--               signatory once. Presenting it deletes the row outright -- not
--               a soft delete, because "withdraw my consent" means the data
--               goes, not that a flag is set on it.
--
-- Email is stored lowercased and uniquely so one person signs once, and so a
-- withdrawal cannot be defeated by re-signing with different capitalisation.
-- =============================================================================

CREATE TABLE petition_signatures (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  name              TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),

  -- Lowercased by the trigger below so uniqueness is case-insensitive.
  email             TEXT NOT NULL CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),

  -- Free text rather than a foreign key to monitors.city: someone in a city we
  -- do not yet cover is exactly the person whose support is worth having.
  city              TEXT NOT NULL CHECK (length(btrim(city)) BETWEEN 1 AND 60),

  -- Signing is not subscribing. Separate, and defaulting to false.
  wants_updates     BOOLEAN NOT NULL DEFAULT false,

  -- What this person was told they were agreeing to, frozen at signing time.
  purpose           TEXT NOT NULL DEFAULT
    'Support for building hyperlocal air quality measurement in India. Shown as an aggregate count publicly; name and city may be shown to funders in aggregate or anonymised form; email used only to contact signatories who opted in.',

  -- Returned to the signatory once, then never readable again.
  withdrawal_token  UUID NOT NULL DEFAULT gen_random_uuid(),

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Two years, unless the signatory withdraws sooner.
  expires_at        TIMESTAMPTZ NOT NULL DEFAULT now() + interval '2 years'
);

-- One signature per person. Case-insensitivity is enforced by the trigger.
CREATE UNIQUE INDEX petition_signatures_email_uniq ON petition_signatures (email);

-- Withdrawal looks up by token alone, so it must be indexed and unguessable.
CREATE UNIQUE INDEX petition_signatures_token_uniq ON petition_signatures (withdrawal_token);

CREATE INDEX petition_signatures_expires_idx ON petition_signatures (expires_at);

-- Normalise on the way in, so the unique index means what it looks like it means.
CREATE OR REPLACE FUNCTION normalise_petition_signature()
RETURNS TRIGGER AS $$
BEGIN
  NEW.email := lower(btrim(NEW.email));
  NEW.name  := btrim(NEW.name);
  NEW.city  := btrim(NEW.city);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER on_petition_signature_normalise
  BEFORE INSERT OR UPDATE ON petition_signatures
  FOR EACH ROW
  EXECUTE FUNCTION normalise_petition_signature();

-- ─── Row-level security ──────────────────────────────────────────────────────

ALTER TABLE petition_signatures ENABLE ROW LEVEL SECURITY;

-- Anyone may sign.
CREATE POLICY petition_signatures_public_insert ON petition_signatures
  FOR INSERT WITH CHECK (true);

-- Nobody may read. There is deliberately no SELECT policy: with RLS enabled and
-- no policy, SELECT is denied for anon and authenticated alike. Only
-- service_role, which bypasses RLS, can read the table.
--
-- There is deliberately no UPDATE policy either. A signature is not editable;
-- to change it, withdraw and sign again.

-- ─── The only public fact about this table ───────────────────────────────────
-- SECURITY DEFINER so it can count rows the caller cannot read. It returns an
-- integer and nothing else, so it cannot be used to probe for a given person.

CREATE OR REPLACE FUNCTION petition_count()
RETURNS INTEGER
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT count(*)::INTEGER FROM petition_signatures WHERE expires_at > now();
$$;

-- ─── Withdrawal ──────────────────────────────────────────────────────────────
-- Deletes outright rather than flagging. "Withdraw my consent" means the data
-- goes. SECURITY DEFINER because the caller has no DELETE policy, and it
-- returns whether a row matched so the caller can be told honestly — without
-- revealing anything about who else is in the table.

CREATE OR REPLACE FUNCTION withdraw_petition_signature(token UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  removed INTEGER;
BEGIN
  DELETE FROM petition_signatures WHERE withdrawal_token = token;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed > 0;
END;
$$;

-- ─── Retention ───────────────────────────────────────────────────────────────
-- Call from a scheduled job. Deleting expired rows is the retention promise
-- being kept rather than merely stated.

CREATE OR REPLACE FUNCTION purge_expired_signatures()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  removed INTEGER;
BEGIN
  DELETE FROM petition_signatures WHERE expires_at <= now();
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$$;

COMMENT ON TABLE petition_signatures IS
  'Personal data. INSERT-only under RLS; readable solely via service_role. '
  'Public count comes from petition_count(). Withdrawal deletes the row.';

COMMENT ON COLUMN petition_signatures.purpose IS
  'The consent text as shown at signing time, frozen per row so a later change '
  'to the wording cannot retroactively reinterpret what someone agreed to.';

COMMENT ON COLUMN petition_signatures.withdrawal_token IS
  'Shown to the signatory once and never again. The only way to withdraw '
  'without operator involvement, since there is no email sender to verify with.';
