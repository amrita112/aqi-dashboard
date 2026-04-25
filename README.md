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

Files 1 and 2 set up the database structure. Files 3 and 4 populate it with sample data so you can see the dashboard in action without submitting your own readings.

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

## Project Structure

```
app/           Next.js routes and pages
components/    Reusable UI components
lib/           Supabase client, utilities, types
database-setup/ SQL files to set up the database (run in order)
scripts/       Data import scripts (e.g., fetch_openaq.py)
```
