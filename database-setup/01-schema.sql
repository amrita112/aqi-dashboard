-- =============================================================================
-- AQI Dashboard — Database Migration
-- =============================================================================
-- Run this SQL in your Supabase project's SQL Editor (Dashboard > SQL Editor).
-- It creates the tables, enables PostGIS, and sets up security policies.
-- =============================================================================

-- Enable PostGIS extension for geospatial queries (e.g., "find readings within 5 km").
-- This is free in Supabase and adds location-aware capabilities to Postgres.
CREATE EXTENSION IF NOT EXISTS postgis;

-- =============================================================================
-- PROFILES TABLE
-- =============================================================================
-- Stores basic user info. Each row links to a Supabase Auth user.
-- Think of this as a "users" table that holds display names and any future profile data.
CREATE TABLE profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Automatically create a profile when a new user signs up.
-- This is a "trigger" — it runs a function every time a new user is created in auth.users.
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id)
  VALUES (NEW.id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION handle_new_user();

-- =============================================================================
-- READINGS TABLE
-- =============================================================================
-- The core table: each row is one AQI reading submitted by a user.
CREATE TABLE readings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,
  aqi_value INTEGER NOT NULL CHECK (aqi_value >= 0 AND aqi_value <= 500),
  latitude FLOAT8 NOT NULL,
  longitude FLOAT8 NOT NULL,
  location GEOGRAPHY(Point, 4326),  -- PostGIS spatial column, auto-computed below
  image_url TEXT,                    -- Future: URL to photo of the monitor
  device_type TEXT,                  -- Future: monitor model/brand
  recorded_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Automatically compute the PostGIS "location" column from latitude and longitude.
-- This means your app code just inserts regular lat/lng numbers,
-- and the database handles creating the spatial point behind the scenes.
CREATE OR REPLACE FUNCTION set_reading_location()
RETURNS TRIGGER AS $$
BEGIN
  NEW.location := ST_SetSRID(ST_MakePoint(NEW.longitude, NEW.latitude), 4326)::geography;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER on_reading_set_location
  BEFORE INSERT OR UPDATE ON readings
  FOR EACH ROW
  EXECUTE FUNCTION set_reading_location();

-- Index on the location column for fast spatial queries (e.g., "within 5 km").
CREATE INDEX readings_location_idx ON readings USING GIST (location);

-- Index on recorded_at for fast time-range queries (e.g., "last 24 hours").
CREATE INDEX readings_recorded_at_idx ON readings (recorded_at DESC);

-- =============================================================================
-- PostGIS QUERY FUNCTION
-- =============================================================================
-- A reusable database function that finds all readings within a given radius.
-- Called from the app via supabase.rpc("readings_within_radius", { ... }).
CREATE OR REPLACE FUNCTION readings_within_radius(
  lat FLOAT8,
  lng FLOAT8,
  radius_meters FLOAT8 DEFAULT 5000
)
RETURNS SETOF readings AS $$
BEGIN
  RETURN QUERY
  SELECT *
  FROM readings
  WHERE ST_DWithin(
    location,
    ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography,
    radius_meters
  )
  ORDER BY recorded_at DESC;
END;
$$ LANGUAGE plpgsql;

-- =============================================================================
-- ROW LEVEL SECURITY (RLS)
-- =============================================================================
-- RLS controls who can read/write data. Think of it like file permissions:
-- - Everyone can READ all readings (the dashboard is public)
-- - Only logged-in users can INSERT their own readings
-- - Users can only UPDATE or DELETE their own readings

ALTER TABLE readings ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

-- Anyone can view all readings (public dashboard)
CREATE POLICY "Readings are viewable by everyone"
  ON readings FOR SELECT
  USING (true);

-- Logged-in users can insert readings (user_id is automatically set to their ID)
CREATE POLICY "Users can insert their own readings"
  ON readings FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Users can only update their own readings
CREATE POLICY "Users can update their own readings"
  ON readings FOR UPDATE
  USING (auth.uid() = user_id);

-- Users can only delete their own readings
CREATE POLICY "Users can delete their own readings"
  ON readings FOR DELETE
  USING (auth.uid() = user_id);

-- Anyone can view profiles
CREATE POLICY "Profiles are viewable by everyone"
  ON profiles FOR SELECT
  USING (true);

-- Users can update their own profile
CREATE POLICY "Users can update their own profile"
  ON profiles FOR UPDATE
  USING (auth.uid() = id);
