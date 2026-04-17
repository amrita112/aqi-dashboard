-- =============================================================================
-- Seed Data — realistic test AQI readings for Indian cities
-- =============================================================================
-- Run this in Supabase SQL Editor to populate the dashboard with test data.
-- Uses real city coordinates and realistic AQI values based on typical readings.
--
-- We need a user_id to associate readings with. This script creates a
-- "test data" user first, then inserts readings under that user.
-- =============================================================================

-- Step 1: Create a test user in auth.users (Supabase's user table)
-- This is a fake user that "submitted" all the seed data.
INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at, created_at, updated_at, instance_id, aud, role)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'testdata@aqi-dashboard.dev',
  '$2a$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012',
  now(),
  now(),
  now(),
  '00000000-0000-0000-0000-000000000000',
  'authenticated',
  'authenticated'
)
ON CONFLICT (id) DO NOTHING;

-- Step 2: The trigger should auto-create a profile, but let's ensure it exists
INSERT INTO profiles (id, display_name)
VALUES ('00000000-0000-0000-0000-000000000001', 'simulated', 'Test Data Bot')
ON CONFLICT (id) DO NOTHING;

-- Step 3: Insert AQI readings across major Indian cities
-- Each city has multiple readings over the past 7 days to show time series
-- AQI values are realistic for each city (Delhi is high, Kerala coast is lower, etc.)

INSERT INTO readings (user_id, source, aqi_value, latitude, longitude, recorded_at) VALUES

-- Delhi (notoriously high AQI, especially in winter)
('00000000-0000-0000-0000-000000000001', 'simulated', 312, 28.6139, 77.2090, now() - interval '7 days'),
('00000000-0000-0000-0000-000000000001', 'simulated', 287, 28.6139, 77.2090, now() - interval '6 days'),
('00000000-0000-0000-0000-000000000001', 'simulated', 345, 28.6139, 77.2090, now() - interval '5 days'),
('00000000-0000-0000-0000-000000000001', 'simulated', 298, 28.6139, 77.2090, now() - interval '4 days'),
('00000000-0000-0000-0000-000000000001', 'simulated', 267, 28.6139, 77.2090, now() - interval '3 days'),
('00000000-0000-0000-0000-000000000001', 'simulated', 310, 28.6139, 77.2090, now() - interval '2 days'),
('00000000-0000-0000-0000-000000000001', 'simulated', 275, 28.6139, 77.2090, now() - interval '1 day'),
('00000000-0000-0000-0000-000000000001', 'simulated', 290, 28.6139, 77.2090, now()),

-- Gurgaon (near Delhi, similarly high)
('00000000-0000-0000-0000-000000000001', 'simulated', 280, 28.4595, 77.0266, now() - interval '6 days'),
('00000000-0000-0000-0000-000000000001', 'simulated', 305, 28.4595, 77.0266, now() - interval '4 days'),
('00000000-0000-0000-0000-000000000001', 'simulated', 265, 28.4595, 77.0266, now() - interval '2 days'),
('00000000-0000-0000-0000-000000000001', 'simulated', 288, 28.4595, 77.0266, now()),

-- Mumbai (moderate, coastal city)
('00000000-0000-0000-0000-000000000001', 'simulated', 145, 19.0760, 72.8777, now() - interval '7 days'),
('00000000-0000-0000-0000-000000000001', 'simulated', 132, 19.0760, 72.8777, now() - interval '5 days'),
('00000000-0000-0000-0000-000000000001', 'simulated', 158, 19.0760, 72.8777, now() - interval '3 days'),
('00000000-0000-0000-0000-000000000001', 'simulated', 120, 19.0760, 72.8777, now() - interval '1 day'),
('00000000-0000-0000-0000-000000000001', 'simulated', 138, 19.0760, 72.8777, now()),

-- Bengaluru (generally moderate)
('00000000-0000-0000-0000-000000000001', 'simulated', 95, 12.9716, 77.5946, now() - interval '7 days'),
('00000000-0000-0000-0000-000000000001', 'simulated', 88, 12.9716, 77.5946, now() - interval '5 days'),
('00000000-0000-0000-0000-000000000001', 'simulated', 102, 12.9716, 77.5946, now() - interval '3 days'),
('00000000-0000-0000-0000-000000000001', 'simulated', 78, 12.9716, 77.5946, now() - interval '1 day'),
('00000000-0000-0000-0000-000000000001', 'simulated', 92, 12.9716, 77.5946, now()),

-- Chennai (moderate, coastal)
('00000000-0000-0000-0000-000000000001', 'simulated', 85, 13.0827, 80.2707, now() - interval '6 days'),
('00000000-0000-0000-0000-000000000001', 'simulated', 72, 13.0827, 80.2707, now() - interval '4 days'),
('00000000-0000-0000-0000-000000000001', 'simulated', 90, 13.0827, 80.2707, now() - interval '2 days'),
('00000000-0000-0000-0000-000000000001', 'simulated', 68, 13.0827, 80.2707, now()),

-- Kolkata (moderately high)
('00000000-0000-0000-0000-000000000001', 'simulated', 178, 22.5726, 88.3639, now() - interval '7 days'),
('00000000-0000-0000-0000-000000000001', 'simulated', 195, 22.5726, 88.3639, now() - interval '5 days'),
('00000000-0000-0000-0000-000000000001', 'simulated', 165, 22.5726, 88.3639, now() - interval '3 days'),
('00000000-0000-0000-0000-000000000001', 'simulated', 188, 22.5726, 88.3639, now() - interval '1 day'),
('00000000-0000-0000-0000-000000000001', 'simulated', 172, 22.5726, 88.3639, now()),

-- Patna (very high, Indo-Gangetic plain)
('00000000-0000-0000-0000-000000000001', 'simulated', 340, 25.6093, 85.1376, now() - interval '6 days'),
('00000000-0000-0000-0000-000000000001', 'simulated', 298, 25.6093, 85.1376, now() - interval '4 days'),
('00000000-0000-0000-0000-000000000001', 'simulated', 356, 25.6093, 85.1376, now() - interval '2 days'),
('00000000-0000-0000-0000-000000000001', 'simulated', 320, 25.6093, 85.1376, now()),

-- Lucknow (high, UP)
('00000000-0000-0000-0000-000000000001', 'simulated', 245, 26.8467, 80.9462, now() - interval '7 days'),
('00000000-0000-0000-0000-000000000001', 'simulated', 268, 26.8467, 80.9462, now() - interval '5 days'),
('00000000-0000-0000-0000-000000000001', 'simulated', 232, 26.8467, 80.9462, now() - interval '3 days'),
('00000000-0000-0000-0000-000000000001', 'simulated', 255, 26.8467, 80.9462, now() - interval '1 day'),
('00000000-0000-0000-0000-000000000001', 'simulated', 240, 26.8467, 80.9462, now()),

-- Hyderabad (moderate)
('00000000-0000-0000-0000-000000000001', 'simulated', 110, 17.3850, 78.4867, now() - interval '6 days'),
('00000000-0000-0000-0000-000000000001', 'simulated', 98, 17.3850, 78.4867, now() - interval '4 days'),
('00000000-0000-0000-0000-000000000001', 'simulated', 125, 17.3850, 78.4867, now() - interval '2 days'),
('00000000-0000-0000-0000-000000000001', 'simulated', 105, 17.3850, 78.4867, now()),

-- Kochi (good, Kerala coast)
('00000000-0000-0000-0000-000000000001', 'simulated', 45, 9.9312, 76.2673, now() - interval '7 days'),
('00000000-0000-0000-0000-000000000001', 'simulated', 38, 9.9312, 76.2673, now() - interval '5 days'),
('00000000-0000-0000-0000-000000000001', 'simulated', 52, 9.9312, 76.2673, now() - interval '3 days'),
('00000000-0000-0000-0000-000000000001', 'simulated', 42, 9.9312, 76.2673, now() - interval '1 day'),
('00000000-0000-0000-0000-000000000001', 'simulated', 48, 9.9312, 76.2673, now()),

-- Jaipur (moderately high)
('00000000-0000-0000-0000-000000000001', 'simulated', 185, 26.9124, 75.7873, now() - interval '6 days'),
('00000000-0000-0000-0000-000000000001', 'simulated', 198, 26.9124, 75.7873, now() - interval '4 days'),
('00000000-0000-0000-0000-000000000001', 'simulated', 175, 26.9124, 75.7873, now() - interval '2 days'),
('00000000-0000-0000-0000-000000000001', 'simulated', 190, 26.9124, 75.7873, now()),

-- Varanasi (high, UP)
('00000000-0000-0000-0000-000000000001', 'simulated', 258, 25.3176, 82.9739, now() - interval '7 days'),
('00000000-0000-0000-0000-000000000001', 'simulated', 275, 25.3176, 82.9739, now() - interval '5 days'),
('00000000-0000-0000-0000-000000000001', 'simulated', 242, 25.3176, 82.9739, now() - interval '3 days'),
('00000000-0000-0000-0000-000000000001', 'simulated', 260, 25.3176, 82.9739, now()),

-- Shillong (good, Northeast)
('00000000-0000-0000-0000-000000000001', 'simulated', 35, 25.5788, 91.8933, now() - interval '6 days'),
('00000000-0000-0000-0000-000000000001', 'simulated', 28, 25.5788, 91.8933, now() - interval '4 days'),
('00000000-0000-0000-0000-000000000001', 'simulated', 42, 25.5788, 91.8933, now() - interval '2 days'),
('00000000-0000-0000-0000-000000000001', 'simulated', 32, 25.5788, 91.8933, now()),

-- Chandigarh (moderate-high)
('00000000-0000-0000-0000-000000000001', 'simulated', 155, 30.7333, 76.7794, now() - interval '7 days'),
('00000000-0000-0000-0000-000000000001', 'simulated', 168, 30.7333, 76.7794, now() - interval '5 days'),
('00000000-0000-0000-0000-000000000001', 'simulated', 142, 30.7333, 76.7794, now() - interval '3 days'),
('00000000-0000-0000-0000-000000000001', 'simulated', 160, 30.7333, 76.7794, now());
