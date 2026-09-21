# Forecast architecture — from OpenAQ to the user's screen

Written 2026-09-20 as the day-3 build spec. Every number here was measured; the
measurements are reproducible in `notebooks/forecast_feasibility.ipynb`.

## The question this answers

The user picks a location. Location is continuous — we cannot enumerate every
point a user might stand on, so we cannot precompute "the forecast for here".
But refitting a model per request is far too slow: climatology is built from
years of history.

So neither extreme works, and the design is a split:

> **Precompute everything that does not depend on the user's location.
> Do only the location-dependent part at request time.**

What varies by location is *which stations are nearby*, and combining a handful
of per-station forecasts is arithmetic. What is expensive — fitting the
seasonal curve, fitting the anomaly-carry weight, building the diurnal shape,
computing today's anomaly — depends only on the station and the date.

## Why per-station precomputation is valid

The obvious worry: our backtest forecast the *aggregate* of k stations, but
precomputing forces us to forecast each station and average afterwards. Are
those the same thing?

Measured: **they differ by 0.5–1.3 µg/m³**, against forecast errors of 7–35.
Well inside the noise.

The reason is algebraic. The model is

    forecast = climatology + α × (latest observation − climatology)

which is linear in its inputs, so averaging the forecasts equals forecasting
the average *provided α is the same for every station*. With a shared per-city
α the two agree to ~1 µg/m³ (the residue is stations having different
missing-day patterns, so the aggregate's climatology is not exactly the mean of
the station climatologies). With per-station α the gap roughly doubles.

**Therefore α is fitted per city, not per station.** That is not a compromise
for convenience — it is what makes precomputation equal the thing we validated.

## Tables

Four, all small. Sizes assume 171 stations, 7 cities, 4 pollutants.

| table | grain | rows | rewritten |
|---|---|---|---|
| `forecast_params` | station × pollutant | 684 | monthly |
| `diurnal_shape` | city × pollutant × month × hour | 8,064 | monthly |
| `forecast_daily` | station × pollutant × date (7 days) | 4,788 | nightly |
| `forecast_bands` | city × pollutant × horizon | 84 | monthly |

**`forecast_params`** holds the fitted model per station: the 366-value
climatology curve stored as a float array (one row, not 366 rows — the array
keeps this table around 1 MB instead of 15), the per-city α for horizons 1–3,
and the station's last-fitted date plus how many days of history backed it.
That history count is what drives the thin-station fallback below.

**`diurnal_shape`** holds the ratio of each hour to that day's mean. Held per
*city* rather than per station: the shape is a regional pattern, and per-station
shapes would need far more history for a modest gain. Worth revisiting if
traffic-adjacent stations turn out to have materially sharper peaks — that is
untested.

**`forecast_daily`** is the nightly output: seven days ahead per station, each
row carrying the value, its method (`blend` / `persistence` / `climatology`),
and the age of the observation it was built from. That last column is what the
UI reads to say "based on a reading 19 hours old" rather than implying it is
live.

**`forecast_bands`** holds the uncertainty as a **ratio**, not an absolute
width, so one number serves Delhi at 200 µg/m³ and Bengaluru at 30 without a
per-level table. Measured p80 residuals, pooled: **±27% at day 1, ±37% day 2,
±41% day 3** — the widening the mockups show. Chennai is materially wider
(42–60%), consistent with it having only four working stations.

## What runs when

**Every 6 hours — `ingest_recent_readings.yml`.** OpenAQ → `readings` +
`measurements`. Note OpenAQ publishes India in one daily batch, so this job
finds new data roughly once a day, not four times; the 6-hourly cadence exists
to catch the batch promptly whenever it lands.

**Daily — `ingest-daily.yml`.** S3 archive at T-7, fills anything the live path
missed. This is the completeness path.

**Daily — rollup.** `readings` → `readings_daily` (station × pollutant × day).
The forecast reads only this, never raw readings.

**Nightly — the forecast job.** For each station: read the most recent daily
value, subtract that day's climatology to get the anomaly, carry it forward
with α for days 1–3, use bare climatology for days 4–7, write 7 rows. Runs
after the rollup. Cost is 171 × 4 lookups against precomputed curves — seconds,
not minutes.

**Monthly — the refit job.** Rebuild climatology, α, diurnal shape and band
quantiles from the full history. The expensive one, and it only needs to run
monthly because it rests on years of data; one more month barely moves it.

## Serving one request

User's location arrives. Then:

1. **Find nearby stations.** PostGIS k-nearest on `monitors`, k = 5, capped at
   a sensible radius so a user far from any monitor does not silently get one
   50 km away. Returns station ids and distances.
2. **Drop stations with no usable forecast** — thin history or no recent
   observation (see fallbacks). If fewer than 3 survive, fall back to the
   city-level forecast and say so in the response.
3. **Fetch and average.** `forecast_daily` for those stations, 7 days. Average
   across stations. Inverse-distance weighting is an option here, but plain
   averaging is what was validated, so start there.
4. **Expand to hours.** Multiply each daily value by
   `diurnal_shape[city, pollutant, month, hour]` — 7 days × 24 = 168 points.
5. **Attach bands.** `forecast_bands[city, pollutant, horizon]` gives a ratio;
   upper = value × (1 + r), lower = value × (1 − r). Days 4–7 get no band —
   they are an average, and drawing uncertainty around them implies a
   prediction we are not making.
6. **Label honestly.** Days 1–3 are `forecast`; days 4–7 are
   `seasonal_normal`. The response carries the observation age, the station
   count, and the method used, because the UI promises all three.

Total work: one spatial query, two small table reads, and a multiply. No model
fitting in the request path.

## Fallbacks

Each degrades one step rather than failing.

| condition | behaviour |
|---|---|
| station has < 1 year of history | excluded from the k-nearest set; it has no trustworthy climatology |
| station's latest observation > 4 days old | excluded; at that lag the forecast is no better than the seasonal average |
| fewer than 3 usable stations nearby | use the city-level forecast, flag `coverage: city` |
| no recent observation anywhere in the city | serve climatology alone for all 7 days, labelled `seasonal_normal` throughout |
| user outside all seven city boxes | no forecast; offer the nearest supported city |

The 4-day staleness cut is not arbitrary: with 4-day-old input, skill against
the seasonal average falls to +6% at day 1 and goes *negative* by day 3. Past
that point a "forecast" is an average wearing a hat, and we should say so.

## Known gaps

- **The diurnal shape is per city.** Whether traffic-adjacent stations need
  their own shape is untested.
- **Bands come from city-level residuals.** Per-station residuals are probably
  wider; the bands may be slightly optimistic for a single-station location.
- **No weather input.** This is the ceiling on the whole approach — PM2.5
  beyond a couple of days is governed by wind, boundary-layer height and
  rainfall, none of which the model sees. It is the single change that would
  extend the useful horizon past three days, and it is a v2 project.
