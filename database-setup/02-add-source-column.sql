-- =============================================================================
-- Migration: Add "source" column to readings table
-- =============================================================================
-- This adds a column that tracks where each reading came from:
--   'user'       — manually entered by a user via the website
--   'openaq'     — imported from the OpenAQ database
--   'simulated'  — generated test data
--   'government' — from official/government sources (e.g., CPCB)
--
-- The default is 'user', so any existing readings (and new user submissions)
-- automatically get tagged as 'user' without changing the form.
-- =============================================================================

-- Add the source column with a default value of 'user'
ALTER TABLE readings
ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'user';

-- Tag any readings that came from the OpenAQ import.
-- We identify them by the test user ID used in the import script.
UPDATE readings
SET source = 'openaq'
WHERE user_id = '00000000-0000-0000-0000-000000000001';
