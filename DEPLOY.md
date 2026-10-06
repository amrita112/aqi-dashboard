# Deploying

Everything here is on a free tier. Nothing in this app costs money to run, and
that is a constraint rather than an accident — see `lib/ai/provider.ts`.

---

## Before you deploy

### 1. Decide the app name

**This is the only genuine blocker.** It is currently the placeholder
`Saaf Hawa` in `lib/brand.ts`, and it appears in four places a user sees:

- the label under the icon on their home screen
- the browser tab and the install prompt
- the title of every page
- the domain

Change `APP_NAME` and `APP_SHORT_NAME` in `lib/brand.ts`, then regenerate the
icons so they stay in step:

```bash
python3 scripts/make-icons.py
```

`APP_SHORT_NAME` is what survives under a home-screen icon — roughly 12
characters before iOS and Android truncate it.

### 2. Apply the outstanding migration

`database-setup/16-petition-signatures.sql`, via the Supabase SQL Editor.
Until it runs, `/petition` renders but cannot accept a signature, and
`/api/petition` returns a clear 502.

### 3. Get a Groq key

<https://console.groq.com> — no card required. Without it `/api/ask` returns
503 and says so plainly; everything else works.

---

## Environment variables

Set all five in **Vercel → Settings → Environment Variables**, for Production
and Preview.

| Variable | Where from | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Settings → API | Public by design |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase → Settings → API | Public by design |
| `AI_API_KEY` | console.groq.com | **No `NEXT_PUBLIC_` prefix** |
| `AI_BASE_URL` | `https://api.groq.com/openai/v1` | |
| `AI_MODEL` | `llama-3.3-70b-versatile` | Tool calling + JSON mode |

**`SUPABASE_SERVICE_ROLE_KEY` must NOT be set in Vercel.** It bypasses row-level
security entirely and is only used by the Python ingest jobs, which run in
GitHub Actions. Nothing in `app/`, `lib/` or `components/` reads it, and it has
no business reaching a web server that renders pages for the public.

The `NEXT_PUBLIC_` keys genuinely are public — they ship to the browser by
design. What protects the data is row-level security, not key secrecy: every
table is `SELECT`-only for anonymous callers, and `petition_signatures` is not
readable at all.

---

## Deploy

```bash
npx vercel          # preview
npx vercel --prod   # production
```

The build must be clean before you start — Vercel runs `next build`, and a
single ESLint **error** fails the deploy:

```bash
npm run lint && npx tsc --noEmit && npm test && npx next build
```

---

## After deploying

### Check the install flow

The PWA is the point: on iOS, a home-screen install is the only way the app
runs full-screen, and the only way web push could ever work.

1. Open the production URL on an Android phone in Chrome → an install prompt
   should appear, or Menu → "Add to Home screen"
2. On iPhone, Safari → Share → **Add to Home Screen** (iOS offers no prompt,
   ever — the user has to know)
3. Launch from the home screen: no browser chrome, the gauge icon, the app name
4. Turn off wifi and mobile data, reopen → the offline page, not a dinosaur

### Check the data is live

```
/api/locations                      7 cities, ~170 stations
/api/forecast?lat=28.61&lng=77.21   tomorrow, with a mode
/api/ask    POST {"question":"..."} a real answer, or 503 if no key
```

---

## Scheduled jobs

These keep the data moving and run in **GitHub Actions**, not Vercel. They need
repository secrets — `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
`OPENAQ_API_KEY` — which are separate from the Vercel variables above.

| Workflow | When | What |
|---|---|---|
| `ingest_recent_readings.yml` | every 6h | live OpenAQ |
| `ingest-daily.yml` | 04:00 UTC | S3 backfill at T-7 |
| `rollup-daily.yml` | 05:00 UTC | compress to `readings_daily` |
| `forecast-nightly.yml` | 05:30 UTC | rewrite `forecast_daily` |
| `forecast-refit.yml` | monthly | refit climatology and alphas |
| `bootstrap-weekly.yml` | Sundays | refresh the station manifest |
| `prune-raw.yml` | Sundays | delete raw past 30 days |

---

## Things that will surprise you later

**Most forecasts are seasonal averages, and that is correct.** Around 40% of
day+1 forecasts come back as `seasonal_normal` because OpenAQ republishes
India's CPCB network days late — measured 2026-09-28, **zero** government
stations in Delhi, Mumbai or Bengaluru had reported within 48 hours, with
median ages of 3.9, 3.9 and 9.2 days. The app says so on screen and offers the
petition. This is not a bug and there is no fix on our side.

**Nothing calls `purge_expired_signatures()` yet.** Petition signatures carry a
two-year retention that nothing currently enforces. Nothing expires until 2028,
but a retention promise with no job behind it is how retention promises get
broken.

**`no-explicit-any` is a warning, not an error** — see `.eslintrc.README.md`.
Raise it back to `error` once the old screens are rebuilt.

**Notifications are not built.** The threshold collected at first run drives the
in-app banner only. The setup screen says so.
