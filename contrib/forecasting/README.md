# Daily air quality forecasting on the XKDR measurements dataset

A backtest of a simple daily forecast for seven Indian cities — Delhi, Mumbai,
Bengaluru, Hyderabad, Chennai, Kolkata and Pune — built directly on the parquet
export.

Contributed because the dataset supports this kind of work well, and because
one finding seemed worth reporting back: **forecast skill collapses with the
age of the most recent reading**, which makes publication latency the binding
constraint for anyone forecasting from it.

## The finding

Delhi, day-ahead PM2.5, held-out 2024, pollution season (Oct–Jan), scored
against climatology:

| Age of the most recent reading | MAE (µg/m³) | Skill vs climatology |
|---|---|---|
| same day | 39.4 | **33%** |
| 1 day | 48.7 | 17% |
| 2 days | 52.0 | 11% |
| 3 days | 55.1 | 6% |
| 4 days | 56.9 | 2% |

Averaged over Delhi's 41 stations, each fitted and scored on its own series.
Climatology — the seasonal average, needing no recent data at all — sits at
58.5. So by four days, a forecast is barely distinguishable from quoting the
long-run average for the date, and the modelling has stopped earning its place.

Put the other way round, as the notebook's final table does: at a one-day
horizon the forecast is still worth calling one with input up to **2 days old**
in Delhi, **1 day** in Bengaluru and Chennai, and **7 days** in Mumbai and
Pune, where day-to-day variation is smaller and the seasonal average is
already a strong answer.

That pattern holds across all seven cities and across held-out years.

## What the analysis does

Per monitoring station: fit a smoothed day-of-year climatology, measure how
persistent departures from it are, and carry the latest departure forward with
a weight fitted on training years only. Scored against two baselines a forecast
has to beat to be worth making — persistence (tomorrow equals today) and
climatology (tomorrow equals the seasonal average).

It also covers:

- **Composite NAQI as well as PM2.5.** AQI is the max of four sub-indices, so
  it is a different forecasting problem from any single pollutant. It turns out
  to forecast about as well.
- **Band agreement** — how often the forecast lands in the right CPCB category,
  which is what a user actually acts on.
- **The diurnal shape** — hour-of-day is a stable multiplicative pattern, so a
  daily forecast can be spread across hours. Worth about 3–8% of hourly
  variance on top of the daily mean.
- **Gaps** — how far back you must look to find any reading at all, which sets
  how much history a forecast needs to keep.

### Fitted and scored per station, not on a city average

Worth flagging because it changes the numbers by about a quarter. Scoring a
city average lets errors at different stations cancel inside the metric: by the
triangle inequality,

```
|mean(ŷ) − mean(y)|  ≤  mean(|ŷᵢ − yᵢ|)
```

so the city-average MAE can never be the larger of the two, however poor the
model. Measured on composite AQI for 2024, the city figure is 71–82% of the
per-station one — Delhi 40.4 against 49.3, Mumbai 15.3 against 21.5. Band
agreement is distorted further, because banding is a threshold and cancellation
helps it more: Mumbai reads 85% city-wide and 72% per station.

Everything here is per station, then averaged across the stations of a city,
because that is the error someone at one location actually experiences.

## Running it

```bash
pip install -r requirements.txt
jupyter notebook forecast_feasibility.ipynb
```

The loaders read the parquet export directly through duckdb. No database, no
API key, nothing to configure — provided the measurements are in a `data/`
directory beside these files. Otherwise:

```bash
export XKDR_DATA_DIR=/path/to/xkdr/data
```

so that `$XKDR_DATA_DIR/v1/measurements/*/*/data.parquet` resolves.

About two minutes end to end, most of it the first duckdb scan. The loaders
cache their aggregates beside the data as parquet (`cache_xkdr_*.parquet`), so
later runs take seconds.

## Files

| | |
|---|---|
| `forecast_feasibility.ipynb` | the analysis |
| `baselines.py` | loaders, the model, and the backtests |
| `aqi_utils.py` | CPCB NAQI sub-indices and bands |
| `aqi-config.json` | the breakpoint tables |

## Notes

- **Test year is 2024**, chosen because it is the most recent year with
  complete pollution-season coverage. The notebook shows the coverage table it
  was chosen from rather than asserting it.
- **Usable national coverage ends around September 2025** in the export used
  here; January–March 2025 carries only four or five stations nationally. The
  analysis stops before that rather than reading the thinning as a change in
  the air.
- **Seasons are Oct–Jan.** Scoring across the full year lets the clean months
  flatter every model, including the baselines.

Extracted from a larger application, with everything specific to that
application removed.
