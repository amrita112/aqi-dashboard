# AQI Dashboard

## Project Overview
A crowdsourced AQI (Air Quality Index) dashboard where users can submit and view air quality readings.

## My background: 
I am a senior policy researcher with some computer science background. I can understand code generally but am not familiar with software components, like databasing, unit testing, running a server, front end programming, etc. 


## Tech Stack
- Next.js 14 (App Router) with TypeScript
- Supabase (Postgres database, auth, real-time)
- Tailwind CSS
- Recharts for charts, Mapbox GL for maps
- Vercel for deployment

## Key Decisions
- Use App Router (not Pages Router)
- Enable PostGIS for geospatial queries 
- Server components by default, suggest when this would not be a good idea and I can decide if I want a client-side component instead
- All AQI values follow EPA scale (0-500)

## Project Structure
- /app — Next.js routes
- /components — reusable UI components
- /lib — Supabase client, utilities, types

## Code Style
- TypeScript strict mode
- Prefer async/await over .then()
- Keep components small and focused
- Add detailed comments explaining what the code does and why

## Forecast verification notebook
- Whenever forecasting logic changes (scripts/forecast/*, lib/api/forecast.ts, averageForecastDays, daily-quality config), update notebooks/forecast_verification.ipynb in the same commit and re-run it.
- It calls the app's own functions (lines marked `# ▶ APP CODE`); fix a changed call there rather than copying logic into the notebook.
- The TypeScript serving layer is mirrored in scripts/forecast/serving_mirror.py. If expandDay, averageForecastDays or nearest_monitors change, update the mirror and tests/fixtures/serving_mirror/cases.json; both tests/test_serving_mirror.py and tests/api/serving-mirror.test.ts must pass.

## Work Style
- Explain technical concepts in plain language, avoiding jargon where possible. However, keep it brief
- When jargon is unavoidable, include a brief definition
- If a task involves risk (e.g., deleting data, changing the database), explain what could go wrong before proceeding
- Explain errors before giving fixes
- Ask before modifying or deleting files

## Programming Skill Level
- Python: strong. Love using Jupyter notebooks for testing, debugging
- Git: functional
- Terminal: functional