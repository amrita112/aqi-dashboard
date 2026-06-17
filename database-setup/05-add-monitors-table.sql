-- =============================================================================
-- Migration: Add `monitors` table and link `readings` to it
-- =============================================================================
-- A "monitor" is one physical air quality measurement device. Examples:
--   - A government-run station (e.g., CPCB monitor in Delhi)
--   - A small handheld unit owned by an individual
--   - An OpenAQ-listed station operated by some other party
--
-- Each row in `monitors` represents one physical device. Most metadata
-- columns (manufacturer, model, etc.) are kept nullable for now — we'll
-- fill them in as we learn what each monitor is.
--
-- Linking model:
--   - Each `readings` row gets a `monitor_id` that points at a monitor.
--   - It is *nullable* so existing readings (user-submitted estimates,
--     historical OpenAQ data without monitor records yet) can keep working.
--   - A user is "connected to" a monitor implicitly: if they uploaded
--     any reading from it, they used it. No explicit ownership table.
--   - One user can use many monitors; one monitor can be used by many users
--     (e.g., when sold to a different person who creates their own account).
--
-- Soft delete:
--   - To retire a bad monitor, set `disabled_at` to now() rather than
--     deleting the row. This preserves the audit trail.
--   - The FK uses ON DELETE RESTRICT so Postgres refuses to hard-delete
--     a monitor that still has any readings — forcing a deliberate cleanup.
-- =============================================================================

-- Create the monitors table.
CREATE TABLE monitors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The manufacturer's hardware identifier (e.g., "PL-12345-A").
  -- Nullable because not every monitor will have one we know about.
  serial_number TEXT,

  -- Manufacturer name (e.g., "Plume Labs"). Empty for now.
  manufacturer TEXT,

  -- Model name (e.g., "Flow 2"). Empty for now.
  model TEXT,

  -- Free-form description / commissioning notes / "where is it installed".
  notes TEXT,

  -- When the monitor was first registered in our system.
  created_at TIMESTAMPTZ DEFAULT now(),

  -- Soft-delete marker. NULL means active; a non-null timestamp means
  -- the monitor was disabled at that moment (e.g., found defective).
  -- App queries should filter on this when showing "active" monitors.
  disabled_at TIMESTAMPTZ
);

-- Once metadata is filled in, two rows describing the same physical device
-- would be a bug. This partial unique index prevents duplicates *only when*
-- both manufacturer and serial_number are known, so it doesn't get in the
-- way of the current "metadata empty" state.
CREATE UNIQUE INDEX monitors_manufacturer_serial_uniq
  ON monitors (manufacturer, serial_number)
  WHERE manufacturer IS NOT NULL AND serial_number IS NOT NULL;

-- Add the foreign key column to readings.
-- Nullable so existing rows (without a known monitor) remain valid.
-- ON DELETE RESTRICT enforces soft-delete: you cannot hard-delete a monitor
-- that has readings pointing at it.
ALTER TABLE readings
  ADD COLUMN monitor_id UUID REFERENCES monitors(id) ON DELETE RESTRICT;

-- Index for the common query "all readings from monitor X".
CREATE INDEX readings_monitor_id_idx ON readings (monitor_id);

-- =============================================================================
-- Row Level Security on monitors
-- =============================================================================
-- - Anyone can see monitors (the map / dashboard is public).
-- - Authenticated users can register a new monitor.
-- - UPDATE / DELETE intentionally have no policy, so only the service role
--   (admin via SQL Editor) can modify or remove monitors. This will be
--   relaxed once we build proper admin tooling and decide who "owns" a
--   monitor for editing purposes.

ALTER TABLE monitors ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Monitors are viewable by everyone"
  ON monitors FOR SELECT
  USING (true);

CREATE POLICY "Authenticated users can register monitors"
  ON monitors FOR INSERT
  TO authenticated
  WITH CHECK (true);
