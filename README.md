# AirGyaan

An installable air quality app for seven Indian cities — Delhi NCR, Mumbai,
Bengaluru, Hyderabad, Chennai, Kolkata and Pune. It answers one question well:
**is it worth going outside, and when?**

It is a progressive web app, not an app store product. You open it in a browser,
add it to your home screen, and it runs full screen with no account.

## What it does

- **A forecast, not a reading, as the headline.** India's public monitoring feed
  publishes on a lag of days, so "the current AQI" is usually yesterday's or last
  week's. The home screen leads with today's forecast for your own neighbourhood,
  hour by hour.
- **Your place, not your city.** You drop a pin where you actually spend time, and
  every number is averaged over the **three nearest monitoring stations** to that
  point. City averages hide the thing you want to know.
- **It says when it does not know.** A day with no recent reading behind it is
  drawn dashed and labelled a *seasonal average*, never a forecast. Nothing in the
  app presents a climatology as a prediction.
- **A question box** over seven fixed tools. The model picks a tool and writes the
  sentence; **every number comes from the database**, never from the model.
- **A map** of the stations near you, including the ones with nothing recent —
  drawn hollow, because where the gaps are is worth seeing.

## How the forecast works

`forecast(day, hour) = [climatology(day) + alpha x anomaly] x shape(city, month, hour)`

A daily level from a blend of the seasonal climatology and the most recent
reading's anomaly, multiplied by a diurnal shape fitted per city and month. The
per-city choice between blend and persistence is stored rather than hardcoded,
and a running bias correction is applied nightly.

Measured, so you do not have to take it on faith: the model needs exactly **one**
recent day (N=1 beats N=2 through 30 in every city), the diurnal shape cuts
hourly error by about **16%** against quoting a flat daily number, and skill
decays sharply as the anchoring reading ages — which is why the app is so
insistent about data age.

## Tech stack

- **Frontend:** Next.js 14 (App Router), TypeScript (strict), Tailwind
- **Database:** Supabase (Postgres + PostGIS, row-level security)
- **Charts:** Recharts. **Maps:** Leaflet + OpenStreetMap
- **AI:** Groq free tier, through a provider-swappable OpenAI-compatible client
- **Scheduled jobs:** GitHub Actions. **Hosting:** Vercel

Everything runs on a free tier, which is a design constraint rather than a
temporary state.

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
| `14-readings-daily-source.sql` | Marks whether a daily row was rolled up from our raw readings or loaded from the XKDR history | Yes |
| `15-timezone-conventions.sql` | Column comments recording which columns are UTC instants and which are IST calendar labels. Changes no data | Yes |
| `16-petition-signatures.sql` | Adds `petition_signatures` — the only table holding personal data, and the only one nobody can read through the app | Yes |
| `17-forecast-bias-correction.sql` | Adds `value_raw` and a `forecast_bias` table, so a systematic under-forecast can be measured and corrected nightly | Yes |
| `18-city-requests.sql` | Reuses the petition table for "add my city" requests via a `kind` column, with partial unique indexes per kind | Yes |

Files 1, 2, 5–18 set up the database structure. Files 3 and 4 populate it with sample data so you can see the dashboard in action without submitting your own readings.

A few of these are worth a sentence, because the reason is not obvious from the name:

- **11** exists because `min_ts`/`max_ts` were single timestamps chosen by whichever matching
  row came back first, and row order is not guaranteed — so re-rolling a day could change the
  answer. About 42% of station-days have a *tied* minimum, and those columns exist to support
  "when is the air cleanest here", so keeping one arbitrary member of the tie threw away most
  of the answer.
- **12** stores the forecast as four small tables (under 14k rows total). Climatology is a
  366-element array on one row per station rather than 366 rows — same information, roughly a
  fifteenth of the space, and it is always read whole.
- **14** matters more than it sounds. `readings_daily` ends up holding two populations that
  look identical: rows rolled up from our own 15-minute readings (a complete day is ~96
  readings) and rows loaded from the XKDR historical export, which is hourly (~24). The daily
  means are directly comparable; the counts are not, and without the column any completeness
  check reads every historical row as three-quarters missing.
- **13** adds a `name` column to `monitors`, which never had one: station names lived only in
  `scripts/ingest/target_stations.json`, so the database could not answer "what is this station
  called". It also seeds `alert_defaults` — per-city notification thresholds set to the median
  daily maximum over October–February, so a user who keeps the default hears from the app on
  roughly half the days of the season.
- **15** changes no data at all. It writes down, as column comments, which columns are UTC
  *instants* and which are IST *calendar labels* — a distinction that was never documented and
  cost two bugs: `readings_daily.date` meant an IST day for XKDR rows and a UTC day for ours,
  and `diurnal_shape.hour` is an IST hour that the forecast code was reading as UTC, rotating
  every hourly profile by five and a half hours.
- **17** exists because the forecast was measurably biased, not because the model
  was wrong. Over 2,490 station-days it under-predicted during the autumn ramp:
  both of its anchors — a seasonal climatology and a reading a median three days
  old — look backwards, so a 30-115% climb over ten days outruns them. Chennai
  was the natural control, the only city whose levels fell and the only one whose
  bias improved. The correction is damped and capped, and `value_raw` keeps the
  uncorrected number so the correction can always be audited or undone.
- **18** reuses the petition table rather than adding a second one. A city request
  has the same shape and the same obligations under the DPDP Act — name, email,
  city, purpose, withdrawal token — so a separate table would have duplicated the
  retention trigger, the withdrawal function and the RLS policies, which is three
  chances for them to drift apart.
- **16** is the only table in this project that holds personal data, so its row-level security
  is deliberately the inverse of every other table's. Everything else is `SELECT USING (true)`
  because air quality is public and the anon key ships to the browser. A list of named people
  is not public: this table has an INSERT policy and **no SELECT policy at all**, so it is
  unreadable through the app under any circumstances, and only `service_role` can see it. The
  public signature count comes from a `SECURITY DEFINER` function that returns an integer.
  Withdrawal *deletes* the row rather than flagging it, and retention is two years enforced by
  `purge_expired_signatures()`.

After running the migrations, populate the derived tables:

```bash
python3 -m scripts.forecast.load_history      # ~991k historical daily rows (~99 MB, one-off)
python3 -m scripts.forecast.refit_params      # climatology, alphas, diurnal shape, modes
python3 -m scripts.forecast.alert_defaults    # per-city notification thresholds
python3 -m scripts.forecast.nightly_forecast  # 7 days ahead per station
```

### 2. Configure environment variables

Copy `.env.local.example` to `.env.local` and fill it in:

```
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
GROQ_API_KEY=...            # or AI_API_KEY; without it the Ask tab says so and the rest works
SUPABASE_SERVICE_ROLE_KEY=  # LOCAL AND CI ONLY — see the warning below
```

The first two are in your Supabase dashboard under Settings > API.

> **Never set `SUPABASE_SERVICE_ROLE_KEY` in your hosting provider.** It bypasses
> row-level security entirely. The ingest and forecast jobs need it and run in
> GitHub Actions; the web app does not and must not have it. The only table it
> would expose is the one holding people's names and email addresses.

The AI provider is swappable: Groq, Cerebras and OpenRouter are all
OpenAI-compatible, so moving is a base URL and a model name (`AI_BASE_URL`,
`AI_MODEL`). Free tiers disappear — GitHub Models was retired in July 2026 — so
nothing hardcodes one.

### 3. Install and run

```bash
npm install
npm run dev     # http://localhost:3000
npm test        # 242 tests, no network or database needed
npm run build   # type-check and production build
```

Python jobs run from the repo root as modules, e.g.
`python3 -m scripts.forecast.nightly_forecast`. Most take `--dry-run`.

### 4. Scheduled jobs

Seven GitHub Actions workflows keep the data current. They need
`SUPABASE_SERVICE_ROLE_KEY` and `OPENAQ_API_KEY` as repository secrets.

| Workflow | When | What |
|---|---|---|
| `ingest_recent_readings` | every 6 h | Fetch recent measurements from OpenAQ |
| `ingest-daily` | daily 04:00 UTC | The completeness pass behind the freshness one |
| `rollup-daily` | daily 05:00 UTC | Collapse raw readings into `readings_daily` |
| `forecast-nightly` | daily 05:30 UTC | Seven days ahead per station, with bias correction |
| `forecast-refit` | monthly | Refit climatology, alphas, diurnal shape, modes |
| `prune-raw` | weekly | Enforce 30-day raw retention |
| `bootstrap-weekly` | weekly | Re-sync the station manifest |

Order matters: the rollup must finish before the forecast runs, which is why
they sit half an hour apart.

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

## Project structure

```
app/              Next.js routes: /, /setup, /ask, /map, /trends, /settings, /petition
                  plus /api/* — forecast, map, history, ask, current, city-request
                  /dashboard, /submit, /login and /signup are LEGACY, left over
                  from the crowdsourced prototype this grew out of. They still
                  work and are not linked from the app
components/       Screens and charts. The charts are the fussiest part of this repo
                  and the comments explain why
lib/              Supabase clients, AQI maths, preferences, brand
  lib/ai/         The question box: provider, the seven tools, chart building, quota
database-setup/   18 SQL migrations, run in numbered order
scripts/
  scripts/ingest/    OpenAQ fetch, rollup, pruning
  scripts/forecast/  Climatology, refit, nightly forecast, bias correction, simulation
  scripts/analysis/  One-off investigations
tests/            242 TypeScript tests plus Python tests for the jobs
contrib/          Work intended for other people's repositories
docs/             Design documents: storage, forecast architecture, LLM integration
```

Code comments here explain **why**, not what. Most of them record a decision that
was made the other way first — the chart axes, the IST/UTC conventions and the
service worker's refusal to cache readings each cost a bug before they were
written down.

## Licence

The code in this repository is licensed under the **GNU Affero General Public
License v3.0** — see [LICENSE](LICENSE) for the full text.

AGPL rather than MIT because this is a web app. An ordinary GPL obligation is
triggered by *distributing* software, and nobody distributes a web app: they
run it on a server and send you HTML. The AGPL's section 13 closes that gap —
if you run a modified version of this and let other people use it over a
network, you have to offer them the source to your modifications.

What that means in practice:

- **Read it, learn from it, fork it, run it** — yes, for anyone.
- **Use it in research, teaching, or your own city's version** — yes. Please do.
- **Run a modified copy as a public service** — yes, provided you publish your
  changes under the same licence.
- **Take it closed-source and commercial** — no.

To be explicit about what a licence cannot do: copyright covers this code, not
the ideas in it. Anyone is free to read how the forecast works and build their
own. That is fine, and partly the point.

## Data, and how to credit it

**The licence above covers the code only.** It makes no claim over the air
quality measurements, which are not ours and are not licensed by us.

Readings come from India's Central Pollution Control Board monitoring network,
reaching this app two ways: [OpenAQ](https://openaq.org) for recent
measurements, and the XKDR Forum's archive for the history the forecast is
fitted on. The test fixtures under `tests/fixtures/simulation/` are derived
from that archive.

If you use the data — in a paper, report, story or product — cite the database
and credit its two sources, as XKDR asks:

> XKDR Forum (2026). India Air Quality Database. https://airquality.xkdr.org
>
> Sources: Central Pollution Control Board (CPCB), Continuous Ambient Air
> Quality Monitoring network; US Department of State air quality monitors, via
> AirNow.
