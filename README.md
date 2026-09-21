# AQI Dashboard

A crowdsourced Air Quality Index (AQI) dashboard for India. Users with home air quality monitors can submit readings tagged with their GPS location, and anyone can browse air quality data on an interactive map.

## Tech Stack

- **Frontend:** Next.js 14 (App Router), TypeScript, Tailwind CSS
- **Database:** Supabase (Postgres + PostGIS)
- **Charts:** Recharts
- **Maps:** Leaflet + OpenStreetMap

## Getting Started

### 1. Set up Supabase

Create a free project at [supabase.com](https://supabase.com). Then run the SQL files in `database-setup/` using the Supabase SQL Editor (Dashboard > SQL Editor). Run them in numbered order:

| File | What it does | Required? |
|------|-------------|-----------|
| `01-schema.sql` | Creates tables, triggers, indexes, and security policies | Yes |
| `02-add-source-column.sql` | Adds a `source` column to track where readings came from | Yes |
| `03-seed-data.sql` | Inserts simulated test readings for Indian cities | Optional |
| `04-openaq-seed.sql` | Inserts real air quality data from OpenAQ | Optional |
| `05-add-monitors-table.sql` | Adds a `monitors` table and links readings to physical devices | Yes |
| `06-integrity-fixes.sql` | Adds validation constraints, tightened RLS policies, and missing indexes | Yes |
| `07-add-measurements-table.sql` | Adds a `measurements` table for per-pollutant data (PM2.5, PM10, O3, etc.) | Yes |
| `08-ingest-uniqueness.sql` | Uniqueness constraints so re-running an ingest is a no-op rather than a duplicate | Yes |
| `09-fix-readings-uniqueness-index.sql` | Makes the readings index full rather than partial — PostgREST cannot attach a `WHERE` to `ON CONFLICT` | Yes |
| `10-add-readings-daily-rollup.sql` | Adds `readings_daily`: one row per monitor/pollutant/day, ~40× smaller than raw | Yes |
| `11-rollup-tied-timestamps.sql` | Stores *every* timestamp at the daily min and max, not one picked arbitrarily | Yes |
| `12-forecast-tables.sql` | Adds `forecast_params`, `diurnal_shape`, `forecast_daily`, `forecast_modes` | Yes |
| `13-monitor-locations.sql` | Gives `monitors` a name, coordinates and city; adds nearest-station lookup and `alert_defaults` | Yes |

Files 1, 2, 5–13 set up the database structure. Files 3 and 4 populate it with sample data so you can see the dashboard in action without submitting your own readings.

A few of these are worth a sentence, because the reason is not obvious from the name:

- **11** exists because `min_ts`/`max_ts` were single timestamps chosen by whichever matching
  row came back first, and row order is not guaranteed — so re-rolling a day could change the
  answer. About 42% of station-days have a *tied* minimum, and those columns exist to support
  "when is the air cleanest here", so keeping one arbitrary member of the tie threw away most
  of the answer.
- **12** stores the forecast as four small tables (under 14k rows total). Climatology is a
  366-element array on one row per station rather than 366 rows — same information, roughly a
  fifteenth of the space, and it is always read whole.
- **13** adds a `name` column to `monitors`, which never had one: station names lived only in
  `scripts/ingest/target_stations.json`, so the database could not answer "what is this station
  called". It also seeds `alert_defaults` — per-city notification thresholds set to the median
  daily maximum over October–February, so a user who keeps the default hears from the app on
  roughly half the days of the season.

After running the migrations, populate the derived tables:

```bash
python3 -m scripts.forecast.refit_params      # climatology, alphas, diurnal shape, modes
python3 -m scripts.forecast.alert_defaults    # per-city notification thresholds
python3 -m scripts.forecast.nightly_forecast  # 7 days ahead per station
```

### 2. Configure environment variables

Copy `.env.local.example` to `.env.local` (or create `.env.local`) and fill in your Supabase credentials:

```
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
```

You can find these in your Supabase dashboard under Settings > API.

### 3. Install and run

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to see the dashboard.

## How AQI is calculated

The app uses the **India National Air Quality Index (NAQI)** scale by default — the standard published by India's Central Pollution Control Board (CPCB). NAQI has six bands: Good, Satisfactory, Moderate, Poor, Very Poor, and Severe, on a 0–500 scale.

The **US EPA** scale is also supported and can be selected via the `scale` argument on any AQI utility function. EPA has six differently-defined bands (Good, Moderate, Unhealthy for Sensitive Groups, Unhealthy, Very Unhealthy, Hazardous) with different breakpoints, so the same pollutant concentration produces a different composite AQI under each. A future release may expose the scale as a per-user preference.

Composite AQI is computed as the **max of per-pollutant sub-indices** (the standard "worst pollutant wins" approach used by both CPCB and EPA). Each per-pollutant sub-index is a piecewise-linear interpolation between published breakpoints for that pollutant.

**Above-Severe extrapolation.** CPCB defines the top band as open-ended (e.g. PM2.5 ≥ 250 µg/m³ → AQI ≥ 401) without a published upper limit. We take a specific policy for extreme readings: continue the *slope* of the Very Poor band through Severe and beyond. Concretely, each pollutant's Severe band `c_hi` is set to `c_lo + (Very Poor band width)`, which pins AQI = 500 at exactly that concentration and keeps the AQI curve continuous at the Very Poor / Severe boundary. Values above the Severe threshold extrapolate along the same slope up to a hard cap of 1000 (matching the DB `CHECK` on `readings.aqi_value`). This means a Delhi winter PM2.5 spike of 400 µg/m³ reports as AQI 515, not the capped 500 — because 600 is meaningfully worse than 499 for people making decisions. The relevant `c_hi` numbers and reasoning are in the `_comment` field of [`lib/aqi-config.json`](lib/aqi-config.json).

**Instantaneous vs. time-averaged.** Regulatory AQI uses 24-hour or 8-hour rolling averages, appropriate for chronic-exposure monitoring. This app applies the breakpoint formula to the *instantaneous* reading — the standard practice for real-time consumer dashboards (Plume, IQAir, AirNow's real-time widget, etc.), because the product answers "should I go outside right now?" not "what was my average exposure last week?"

Verification: all breakpoint tables and the sub-index formula live in [`lib/aqi-utils.ts`](lib/aqi-utils.ts), with unit tests covering CPCB reference values in [`lib/aqi-utils.test.ts`](lib/aqi-utils.test.ts). The default scale can be flipped by changing `DEFAULT_SCALE` in [`lib/types.ts`](lib/types.ts).

### Unit handling for ingest data

Data sources publish measurements in different units:

| Pollutant | NAQI canonical unit | Commonly seen from OpenAQ |
|---|---|---|
| PM2.5, PM10 | µg/m³ | µg/m³ |
| O3 | µg/m³ | µg/m³ (usually) |
| NO2, SO2 | µg/m³ | **ppb** |
| CO | mg/m³ | **ppb** |

Feeding a raw ppb value into `computeSubIndex()` produces sub-indices off by roughly **1000×** — a moderate CO reading of 500 ppb (≈ 0.57 mg/m³, "Good") would compute as 500 mg/m³ = NAQI 500 ("Severe"). Every ingest path **must** run measurements through `convertToCanonical(pollutant, value, unit)` in [`lib/aqi-utils.ts`](lib/aqi-utils.ts) before computing sub-indices or the composite AQI.

Conversions use standard 25 °C, 1 atm assumptions (matching NAQI and CPCB): 1 ppm = molar-mass ÷ 24.45 mg/m³. Unrecognized units return `null` so bad data can be dropped rather than silently miscomputed.

## Project Structure

```
app/           Next.js routes and pages
components/    Reusable UI components
lib/           Supabase client, utilities, types
database-setup/ SQL files to set up the database (run in order)
scripts/       Data import scripts (e.g., fetch_openaq.py)
```
