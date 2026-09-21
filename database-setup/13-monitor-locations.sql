-- =============================================================================
-- Migration: give monitors coordinates, and a nearest-station lookup
-- =============================================================================
-- monitors has no lat/lng. Coordinates live on individual readings, which is
-- the wrong place for two reasons: finding a station's position means scanning
-- its readings, and a station with no recent readings has no findable position
-- at all -- exactly the stations the app most needs to draw on a map and say
-- "no recent data" about.
--
-- The app has no geolocation. Users pick a city and then a station, so this is
-- not about locating the user; it is about two things the app does constantly:
--   1. drawing every station in a city on a map, and
--   2. finding the k stations nearest a chosen one, because the forecast is an
--      average over the nearest few rather than a single station.
-- =============================================================================

-- `name` is here because monitors never had one. The station name existed only
-- in scripts/ingest/target_stations.json, so the database could not answer
-- "what is this station called" -- which the picker, the map and every AI
-- answer need. `notes` was the closest thing and is free-form.
ALTER TABLE monitors
  ADD COLUMN IF NOT EXISTS name       TEXT,
  ADD COLUMN IF NOT EXISTS latitude   DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS longitude  DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS city       TEXT,
  ADD COLUMN IF NOT EXISTS location   GEOGRAPHY(POINT, 4326);

-- Same trigger pattern as readings: app code writes plain lat/lng, the database
-- maintains the spatial column.
CREATE OR REPLACE FUNCTION set_monitor_location()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.latitude IS NOT NULL AND NEW.longitude IS NOT NULL THEN
    NEW.location := ST_SetSRID(ST_MakePoint(NEW.longitude, NEW.latitude), 4326)::geography;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS on_monitor_set_location ON monitors;
CREATE TRIGGER on_monitor_set_location
  BEFORE INSERT OR UPDATE ON monitors
  FOR EACH ROW
  EXECUTE FUNCTION set_monitor_location();

CREATE INDEX IF NOT EXISTS monitors_location_idx ON monitors USING GIST (location);
CREATE INDEX IF NOT EXISTS monitors_city_idx     ON monitors (city);

-- ─── Nearest stations to a point ─────────────────────────────────────────────
-- Returns the k nearest monitors with a usable forecast, ordered by distance.
--
-- `max_km` matters: without it a user in a city with three working stations
-- silently gets a fourth from 200 km away, averaged in as though it described
-- their air. Better to return fewer stations and let the caller fall back to a
-- city-level answer than to quietly widen the net.
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
    AND ST_DWithin(m.location,
                   ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography,
                   max_km * 1000.0)
  ORDER BY m.location <-> ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography
  LIMIT k;
END;
$$ LANGUAGE plpgsql STABLE;

-- ─── The picker list ─────────────────────────────────────────────────────────
-- Every station the user can choose, grouped by city. Small enough (171 rows)
-- for the app to fetch once and hold; there is no search-as-you-type against
-- the database.
CREATE OR REPLACE FUNCTION list_locations()
RETURNS TABLE (
  monitor_id UUID,
  name       TEXT,
  city       TEXT,
  latitude   DOUBLE PRECISION,
  longitude  DOUBLE PRECISION
) AS $$
  SELECT m.id, m.name, m.city, m.latitude, m.longitude
  FROM monitors m
  WHERE m.location IS NOT NULL
  ORDER BY m.city, m.name;
$$ LANGUAGE sql STABLE;

-- ─── Default alert thresholds, per city and pollutant ───────────────────────
-- Seeded from history rather than invented: the MEDIAN of the daily maximum
-- over October-February, rounded down to the nearest 10 so the number reads as
-- a choice rather than a computation.
--
-- The median has a property worth explaining in the settings screen: a user who
-- keeps the default is notified on roughly half the days of the season. That
-- makes the default self-describing -- "typical for a bad-season day here" --
-- and gives an obvious direction to move it in.
--
-- Rounded DOWN rather than to nearest, so the default is never quietly less
-- sensitive than the number it came from.
CREATE TABLE IF NOT EXISTS alert_defaults (
  city       TEXT             NOT NULL,
  pollutant  TEXT             NOT NULL CHECK (pollutant IN ('pm25', 'aqi')),
  threshold  DOUBLE PRECISION NOT NULL,
  -- Kept so the settings screen can say where the number came from, and so a
  -- later refresh can be compared against it.
  source     TEXT             NOT NULL DEFAULT 'median daily max, Oct-Feb',
  n_days     INTEGER,
  fitted_at  TIMESTAMPTZ      NOT NULL DEFAULT now(),
  PRIMARY KEY (city, pollutant)
);

ALTER TABLE alert_defaults ENABLE ROW LEVEL SECURITY;
CREATE POLICY alert_defaults_public_read ON alert_defaults FOR SELECT USING (true);
