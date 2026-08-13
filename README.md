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

Files 1, 2, 5, 6, and 7 set up the database structure. Files 3 and 4 populate it with sample data so you can see the dashboard in action without submitting your own readings.

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
