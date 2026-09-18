# Storage and forecast design

Measured 2026-09-18. Every number here came from running the query, not from
estimation — re-derive rather than trust if the pipeline changes shape.

## 1. Diurnal forecasting — predicting 3 pm, not just "tomorrow"

**Decomposition.** Forecast the daily mean, then apply a multiplicative
hour-of-day shape:

    forecast(day, hour) = daily_forecast(day) × shape(city, month, hour)

The shape is the historical mean of `value / that day's mean` for each
(month, hour). It is a ratio, so it scales with the level — a shape learned in
a clean month still applies in a dirty one.

**Why this and not per-hour models.** Variance decomposition of hourly PM2.5
(2019-2025) shows the daily mean is overwhelmingly the dominant term:

| city | explained by daily mean | added by diurnal shape | residual |
|---|---|---|---|
| Mumbai | 88.5% | 2.6% | 8.9% |
| Kolkata | 84.7% | 5.8% | 9.4% |
| Hyderabad | 80.6% | 4.1% | 15.3% |
| Delhi | 80.5% | 7.5% | 12.0% |
| Bengaluru | 65.2% | 5.9% | 28.9% |
| Chennai | 59.4% | 6.7% | 33.9% |

Getting the day right is most of the job; the shape is a real but second-order
correction. Twenty-four separate hourly models would chase the residual, which
is weather, not time of day.

**It works.** Forecasting a named hour one day ahead (season, test year 2024),
mean MAE across six cities and three hours:

| method | MAE |
|---|---|
| flat daily mean quoted for every hour | 19.6 |
| **daily × shape** | **16.4** (−16%) |
| same-hour persistence | 16.6 |
| hour-of-day climatology | 22.8 |

The gain concentrates where the shape departs most from the daily mean —
Delhi at 3 pm goes from 71.5 to 48.2, a third better. At 9 am the shape adds
almost nothing, because 9 am happens to sit near the daily mean.

Same-hour persistence scores the same but needs recent *hourly* data and
breaks whenever yesterday has a gap. The shape is a static table, so prefer it.

**"Best time of day" is a real feature.** Taking the shape's three cleanest
daytime hours (6 am-9 pm) and checking where they actually ranked that day,
out of 16:

| city | mean actual rank (random = 8.5) | in true best 5 | µg/m³ saved vs day average |
|---|---|---|---|
| Delhi | 4.4 | 72% | **35.1** |
| Kolkata | 5.3 | 63% | 9.5 |
| Mumbai | 5.1 | 59% | 5.0 |
| Bengaluru | 5.2 | 58% | 4.1 |
| Hyderabad | 6.3 | 51% | 2.9 |
| Chennai | 6.2 | 48% | 5.2 |

Strongest exactly where it matters most. In Delhi, following the advice avoids
35 µg/m³ — a material exposure reduction. In Hyderabad and Chennai the shape is
flatter and the advice is weaker; consider suppressing the recommendation
where the predicted spread across the day is small.

**Cost.** The shape table is 24 hours × 12 months × 6 cities × 4 pollutants =
6,912 rows. Recomputed monthly from history. The app never queries hourly
history — that is the point.

## 2. How much recent data the forecast needs

**One day.** Estimating the recent anomaly from the last N available days,
MAE at +1 day (season, 2024):

| city | N=1 | N=2 | N=3 | N=7 | N=30 |
|---|---|---|---|---|---|
| Delhi | **35.3** | 38.0 | 39.8 | 45.7 | 52.9 |
| Mumbai | **7.1** | 8.5 | 9.4 | 10.3 | 12.3 |
| Bengaluru | **6.6** | 8.0 | 8.6 | 9.8 | 10.8 |
| Hyderabad | **5.5** | 6.2 | 6.8 | 7.9 | 10.1 |
| Chennai | **9.6** | 11.0 | 11.9 | 14.3 | 15.1 |
| Kolkata | **11.9** | 13.9 | 15.3 | 17.9 | 19.6 |

N=1 wins everywhere and more days degrade it monotonically. Pollution episodes
are short; older days dilute the signal rather than stabilising it.

**But gaps set the real floor.** Days back to the most recent available
reading, 2019+, excluding one 90-day XKDR export artefact in Q1 2025:

| percentile | days |
|---|---|
| p50 | 0 |
| p90 | 0 |
| p99 | 6-8 |
| p99.9 | 28 |

So the forecast reads one day but must be able to *find* one. **Keep 30 days
of raw**: covers 99.9% of cases with margin.

## 3. Storage

**Measured volumes.** Six cities, 157 stations.

- Live ingest: 5,413 readings + 19,430 measurements per day = **1.18 MB/day**
  raw, ~2.07 MB/day with index overhead.
- Full history (2009-2025), station × pollutant × **day**: 940,319 rows —
  12.3 MB as parquet, **~94 MB in Postgres**.
- Full history, station × pollutant × **hour**: 21,193,824 rows —
  113 MB as parquet, **~2.1 GB in Postgres**.

Postgres costs roughly 8-20× parquet for this shape of data; row headers and
index entries dwarf the payload when the payload is a float and a timestamp.

**The design that follows.**

| tier | contents | size |
|---|---|---|
| Supabase — raw | readings + measurements, **30-day** rolling window | ~62 MB |
| Supabase — daily | station × pollutant × day, full 17-year history | ~94 MB |
| Supabase — derived | climatology (8,784 rows), diurnal shape (6,912), forecasts (1,884) | <3 MB |
| **Supabase total** | | **~160 MB of 500** |
| Local / object store | station × pollutant × hour parquet, full history | 113 MB |

**We do not need to leave Supabase.** Everything the app serves fits in about
a third of the free tier. The only table that cannot live there is the hourly
history at 2.1 GB — and the app never needs it at request time, because the
diurnal shape distils it into 6,912 rows once a month.

**Compression schedule.** Raw rows older than 30 days are rolled into
`readings_daily` and deleted. That job does not exist yet; it is safe to
defer until the raw window approaches 30 days of accumulation.

**On Cloudflare / Cloud Run / ngrok.** ngrok is a tunnel to your own machine,
not hosting — irrelevant here. Cloud Run runs containers and would replace
Vercel, not the database. Cloudflare R2 (10 GB free, no egress charges) is the
right home for the hourly parquet *if* we ever want it queryable from the app
— DuckDB reads parquet over HTTPS directly, which is exactly how XKDR serves
its own archive. None of this is needed for v1.
