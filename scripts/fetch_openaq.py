"""
Fetch PM2.5 data from OpenAQ for Indian cities and generate SQL to load into Supabase.

This script:
1. Fetches all Indian PM2.5 monitoring stations from OpenAQ
2. For each station, pulls recent hourly PM2.5 readings
3. Converts PM2.5 concentrations (µg/m³) to AQI using the EPA formula
4. Outputs a SQL file that you can paste into Supabase SQL Editor
"""

import json
import urllib.request
import time
import math

API_KEY = "558b223a9dc230574383614d6d97a689c237f679c4338bca4eb034b27d680ad9"
BASE_URL = "https://api.openaq.org/v3"

def api_get(path):
    """Make an authenticated GET request to OpenAQ."""
    url = f"{BASE_URL}{path}"
    req = urllib.request.Request(url, headers={"X-API-Key": API_KEY})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read())
    except Exception as e:
        print(f"  Error fetching {url}: {e}")
        return {"results": []}

def pm25_to_aqi(pm25):
    """
    Convert PM2.5 concentration (µg/m³) to AQI using the EPA breakpoint table.
    This is the standard formula used by the US EPA and adopted by India's CPCB.
    """
    if pm25 < 0:
        return 0
    
    # EPA breakpoints: (pm25_low, pm25_high, aqi_low, aqi_high)
    breakpoints = [
        (0.0, 12.0, 0, 50),
        (12.1, 35.4, 51, 100),
        (35.5, 55.4, 101, 150),
        (55.5, 150.4, 151, 200),
        (150.5, 250.4, 201, 300),
        (250.5, 350.4, 301, 400),
        (350.5, 500.4, 401, 500),
    ]
    
    for bp_lo, bp_hi, aqi_lo, aqi_hi in breakpoints:
        if pm25 <= bp_hi:
            aqi = ((aqi_hi - aqi_lo) / (bp_hi - bp_lo)) * (pm25 - bp_lo) + aqi_lo
            return min(500, max(0, round(aqi)))
    
    return 500  # Above 500.4 µg/m³

def main():
    print("Step 1: Fetching Indian PM2.5 stations...")
    
    # Get all Indian locations with PM2.5 sensors (parameter_id=2)
    all_locations = []
    for page in range(1, 6):  # Up to 5 pages
        data = api_get(f"/locations?countries_id=9&parameter_id=2&limit=100&page={page}")
        results = data.get("results", [])
        if not results:
            break
        all_locations.extend(results)
        print(f"  Page {page}: got {len(results)} locations")
        time.sleep(0.5)
    
    print(f"  Total: {len(all_locations)} locations")
    
    # Extract PM2.5 sensor IDs with coordinates
    sensors = []
    for loc in all_locations:
        coords = loc.get("coordinates", {})
        lat = coords.get("latitude")
        lng = coords.get("longitude")
        if not lat or not lng:
            continue
        for s in loc.get("sensors", []):
            if s["parameter"]["name"] == "pm25":
                sensors.append({
                    "sensor_id": s["id"],
                    "name": loc["name"],
                    "lat": lat,
                    "lng": lng,
                })
    
    print(f"  Found {len(sensors)} PM2.5 sensors with coordinates")
    
    # Deduplicate by location name (keep first sensor per location)
    seen = set()
    unique_sensors = []
    for s in sensors:
        if s["name"] not in seen:
            seen.add(s["name"])
            unique_sensors.append(s)
    
    print(f"  {len(unique_sensors)} unique locations after dedup")
    
    # Limit to ~30 locations to keep API calls reasonable
    sensors_to_fetch = unique_sensors[:30]
    
    print(f"\nStep 2: Fetching measurements for {len(sensors_to_fetch)} stations...")
    
    all_readings = []
    for i, sensor in enumerate(sensors_to_fetch):
        print(f"  [{i+1}/{len(sensors_to_fetch)}] {sensor['name']} (sensor {sensor['sensor_id']})...")
        
        # Fetch up to 24 hourly readings (most recent)
        data = api_get(f"/sensors/{sensor['sensor_id']}/hours?limit=24")
        results = data.get("results", [])
        
        if not results:
            print(f"    No data")
            time.sleep(0.3)
            continue
        
        count = 0
        for r in results:
            value = r.get("value")
            if value is None or value < 0:
                continue
            
            period = r.get("period", {})
            dt_from = period.get("datetimeFrom", {}).get("utc")
            if not dt_from:
                continue
            
            aqi = pm25_to_aqi(value)
            all_readings.append({
                "aqi_value": aqi,
                "pm25_raw": value,
                "lat": sensor["lat"],
                "lng": sensor["lng"],
                "recorded_at": dt_from,
                "station": sensor["name"],
            })
            count += 1
        
        print(f"    Got {count} readings (latest PM2.5={results[0].get('value')})")
        time.sleep(0.3)  # Be nice to the API
    
    print(f"\nStep 3: Generating SQL ({len(all_readings)} total readings)...")
    
    if not all_readings:
        print("ERROR: No readings fetched. The API may be having issues.")
        return
    
    # Generate SQL
    sql_lines = []
    sql_lines.append("-- =============================================================================")
    sql_lines.append("-- OpenAQ Data — real PM2.5 readings from Indian monitoring stations")
    sql_lines.append(f"-- Generated: {len(all_readings)} readings from {len(sensors_to_fetch)} stations")
    sql_lines.append("-- PM2.5 values converted to AQI using EPA breakpoint formula")
    sql_lines.append("-- =============================================================================")
    sql_lines.append("")
    sql_lines.append("-- Create a test user for the imported data")
    sql_lines.append("INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at, created_at, updated_at, instance_id, aud, role)")
    sql_lines.append("VALUES (")
    sql_lines.append("  '00000000-0000-0000-0000-000000000001',")
    sql_lines.append("  'openaq-import@aqi-dashboard.dev',")
    sql_lines.append("  '$2a$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012',")
    sql_lines.append("  now(), now(), now(),")
    sql_lines.append("  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'")
    sql_lines.append(") ON CONFLICT (id) DO NOTHING;")
    sql_lines.append("")
    sql_lines.append("INSERT INTO profiles (id, display_name)")
    sql_lines.append("VALUES ('00000000-0000-0000-0000-000000000001', 'OpenAQ Import')")
    sql_lines.append("ON CONFLICT (id) DO NOTHING;")
    sql_lines.append("")
    sql_lines.append("INSERT INTO readings (user_id, aqi_value, latitude, longitude, source, recorded_at) VALUES")

    value_lines = []
    for r in all_readings:
        value_lines.append(
            f"('00000000-0000-0000-0000-000000000001', {r['aqi_value']}, {r['lat']}, {r['lng']}, 'openaq', '{r['recorded_at']}')"
        )
    
    sql_lines.append(",\n".join(value_lines) + ";")
    
    # Write to file
    output_path = "/Users/amritasingh/Documents/aqi-project/scripts/openaq-seed.sql"
    with open(output_path, "w") as f:
        f.write("\n".join(sql_lines))
    
    print(f"\nDone! SQL written to: scripts/openaq-seed.sql")
    print(f"Total readings: {len(all_readings)}")
    print(f"\nNext step: paste the contents of that file into Supabase SQL Editor and click Run.")

if __name__ == "__main__":
    main()
