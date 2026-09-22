"""
Regression test: the forecast pipeline must still produce the forecasts it
produced on 2026-09-22, given the same inputs.

WHAT THIS CATCHES
    A change in forecast behaviour that nobody intended -- a refactor of the
    rollup, a tweak to the alpha lookup, a reordering of the mode fallback.
    Everything is frozen (observations, climatology curves, diurnal shape, mode
    table), so the only thing that can move the numbers is the code.

WHAT THIS DOES NOT CATCH
    Whether the forecast is any GOOD. The golden file encodes current
    behaviour, bugs included. When you deliberately improve the forecast this
    test is SUPPOSED to fail; regenerate the fixture from
    notebooks/forecast_simulation.ipynb and read the diff.

WHAT THIS FIXTURE DOES NOT EXERCISE
    `alpha_h1`. The effective horizon is `min(data_age + horizon, 3)`, and no
    station in this window ever had same-day data -- the observed effective
    horizons are only 2 and 3. So a change to alpha_h1 passes this test
    silently. Verified by mutation: alpha_h3, the climatology, the diurnal
    ratios and the mode table are all caught; alpha_h1 is not. If the ingest
    ever gets fresh enough for age-0 observations, regenerate the fixture and
    this gap closes by itself.

WHY THERE IS NO ABSOLUTE ERROR THRESHOLD
    A bound like "Delhi day+1 PM2.5 MAE < 18" would pass all autumn and fail
    every day from November, because error scales with concentration. It would
    be measuring Delhi's air, not this code. The quality gate here is therefore
    skill RELATIVE to climatology, which is roughly scale-free.

Run:  python3 -m pytest tests/test_forecast_simulation.py -v
"""

from __future__ import annotations

import json
import sys
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))

FIX = REPO / "tests" / "fixtures" / "simulation"

pytestmark = pytest.mark.skipif(
    not (FIX / "golden_city_hourly.csv").exists(),
    reason="simulation fixture missing — regenerate with notebooks/forecast_simulation.ipynb",
)

# Forecast values are rounded to 4dp in the golden file. Anything above float
# noise is a real behaviour change, not a platform difference.
TOLERANCE = 1e-4

KEY = ["branch", "pollutant", "city", "target_date", "hour"]


@pytest.fixture(scope="module")
def frozen():
    from scripts.forecast import simulate as sim

    meta = json.loads((FIX / "meta.json").read_text())
    data = {name: pd.read_parquet(FIX / f"{name}.parquet")
            for name in ["forecast_params", "diurnal_shape", "forecast_modes", "monitors"]}
    obs = pd.read_parquet(FIX / "observations.parquet")
    golden = pd.read_csv(FIX / "golden_city_hourly.csv")

    run_dates = [date.fromisoformat(d) for d in meta["run_dates"]]
    result = sim.run_simulation(
        obs, data, run_dates,
        pollutants=tuple(meta["pollutants"]),
        branches=tuple(meta["branches"]),
        horizon=meta["horizon_days"],
        verbose=False,
    )
    scored = sim.score_by_city_hour(result)
    scored["target_date"] = scored["target_date"].astype(str)
    golden["target_date"] = golden["target_date"].astype(str)
    return {"meta": meta, "result": result, "scored": scored,
            "golden": golden, "obs": obs, "sim": sim}


def test_same_city_hours_are_produced(frozen):
    """No city-hour appears or disappears."""
    got = set(map(tuple, frozen["scored"][KEY].values))
    want = set(map(tuple, frozen["golden"][KEY].values))
    assert not (want - got), f"{len(want - got)} city-hours no longer produced, e.g. {sorted(want - got)[:3]}"
    assert not (got - want), f"{len(got - want)} unexpected new city-hours, e.g. {sorted(got - want)[:3]}"


@pytest.mark.parametrize("column", ["predicted", "mae", "bias", "rmse"])
def test_city_hourly_values_match_golden(frozen, column):
    """Per-city hourly aggregates reproduce exactly."""
    merged = frozen["golden"].merge(frozen["scored"], on=KEY, suffixes=("_want", "_got"))
    assert len(merged) == len(frozen["golden"]), "join lost rows — keys changed"
    delta = (merged[f"{column}_got"] - merged[f"{column}_want"]).abs()
    worst = delta.max()
    if worst > TOLERANCE:
        bad = merged.loc[delta.idxmax()]
        pytest.fail(
            f"{column} drifted by {worst:.6f} (tolerance {TOLERANCE}); "
            f"worst at {bad['branch']}/{bad['pollutant']}/{bad['city']} "
            f"{bad['target_date']} h{bad['hour']}: "
            f"was {bad[f'{column}_want']}, now {bad[f'{column}_got']}. "
            f"{int((delta > TOLERANCE).sum())} of {len(merged)} rows differ.")


def test_per_station_checksum_matches(frozen):
    """A station-level change that averages out at city level still trips.

    The city aggregate is a mean, so two stations moving in opposite directions
    leave it untouched. The checksum is position-weighted, so it does not.
    """
    result = frozen["result"]
    checksum = (result.groupby(KEY)
                      .apply(lambda g: float(np.round(np.sum(
                          g["predicted"].values * (np.arange(len(g)) + 1)), 4)),
                             include_groups=False)
                      .rename("station_checksum").reset_index())
    checksum["target_date"] = checksum["target_date"].astype(str)

    merged = frozen["golden"][KEY + ["station_checksum"]].merge(
        checksum, on=KEY, suffixes=("_want", "_got"))
    delta = (merged["station_checksum_got"] - merged["station_checksum_want"]).abs()
    n_bad = int((delta > TOLERANCE).sum())
    assert n_bad == 0, (
        f"{n_bad} of {len(merged)} city-hours have a changed per-station forecast "
        f"despite matching city averages — a station-level regression. "
        f"Worst delta {delta.max():.6f}.")


# Combinations known NOT to beat climatology, with the reason. These are
# recorded rather than hidden: each is a real defect with a diagnosis, and the
# xfail flips to a failure the moment one is fixed, which is the signal we want.
#
# Cause: alpha and the mode table are fitted on the CITY-MEAN series in
# fit_city(), then applied per station. City-mean AQI is far smoother than a
# single station's AQI, because averaging ~70 stations cancels the noise the
# max-over-pollutants operator introduces. Measured lag-3 anomaly
# autocorrelation, 2026-09-22:
#
#     Delhi      aqi   city 0.680   station 0.290
#     Bengaluru  aqi   city 0.641   station 0.312
#     Mumbai     aqi   city 0.374   station 0.232   <- small gap, still has skill
#     Delhi      pm25  city 0.330   station 0.231   <- small gap, still has skill
#
# So the alpha over-carries a station's anomaly by more than double in Delhi
# and Bengaluru, and the forecast lands worse than the seasonal average it
# started from. The fix is to fit alpha (and the mode table) on a
# station-level series, the same granularity correction already applied to the
# climatology on 2026-09-22. Until then the app should be serving
# seasonal_normal for AQI in these cities at this data age.
KNOWN_NO_SKILL = {
    ("fixed48", "aqi", "Delhi"),
    ("fixed48", "aqi", "Bengaluru"),
}

BRANCH_POLLUTANT_CITY = [
    (b, p, c)
    for b in ("honest", "fixed48")
    for p in ("pm25", "aqi")
    for c in ("Delhi", "Mumbai", "Bengaluru")
]


@pytest.mark.parametrize("branch,pollutant,city", BRANCH_POLLUTANT_CITY)
def test_forecast_beats_climatology_where_it_claims_to(frozen, branch, pollutant, city):
    """Quality gate, expressed as skill rather than an absolute bound.

    Rows the pipeline labels 'forecast' or 'outlook' assert real skill. Those
    must beat bare climatology on the same hours, or the label is a lie. Rows
    labelled 'seasonal_normal' ARE climatology and are excluded -- they claim
    nothing, which is the honest behaviour that mode exists to produce.

    Parametrized per city so one broken combination does not mask the rest,
    and so KNOWN_NO_SKILL can record exactly what is broken.
    """
    result = frozen["result"]
    grp = result[(result["branch"] == branch)
                 & (result["pollutant"] == pollutant)
                 & (result["city"] == city)
                 & (result["mode"].isin(["forecast", "outlook"]))]
    if grp.empty:
        pytest.skip(f"no {branch}/{pollutant}/{city} rows claim forecast skill")

    forecast_mae = float(np.mean(np.abs(grp["error"])))
    clim_mae = float(np.mean(np.abs(grp["climatology"] - grp["actual"])))
    known = (branch, pollutant, city) in KNOWN_NO_SKILL

    if known:
        # Strict: if this combination starts beating climatology, the defect
        # has been fixed and this entry should be deleted.
        assert forecast_mae > clim_mae, (
            f"{branch}/{pollutant}/{city} now BEATS climatology "
            f"({forecast_mae:.2f} vs {clim_mae:.2f}) -- the city-level-alpha "
            f"defect looks fixed. Remove it from KNOWN_NO_SKILL.")
        pytest.xfail(
            f"known defect: {branch}/{pollutant}/{city} forecast MAE "
            f"{forecast_mae:.2f} vs climatology {clim_mae:.2f}; alpha is fitted "
            f"on the city-mean series and over-carries per-station anomalies")

    assert forecast_mae <= clim_mae, (
        f"{branch}/{pollutant}/{city}: forecast MAE {forecast_mae:.2f} worse "
        f"than climatology {clim_mae:.2f} over {len(grp):,} station-hours -- "
        f"the pipeline labels these rows 'forecast'/'outlook', claiming skill "
        f"it does not have.")


def test_no_negative_or_absurd_forecasts(frozen):
    """Sanity bounds that hold regardless of season.

    A negative concentration is not a forecast, and the AQI scale caps at 1000
    (the CHECK on readings.aqi_value). These are cheap and will not drift.
    """
    result = frozen["result"]
    assert (result["predicted"] >= 0).all(), "negative forecast produced"
    aqi = result[result["pollutant"] == "aqi"]
    assert (aqi["predicted"] <= 1000).all(), "AQI forecast above the 1000 cap"


def test_fixture_does_not_depend_on_supabase(frozen):
    """The fixture must be self-contained: raw readings past 30 days are pruned."""
    for name in ["observations.parquet", "forecast_params.parquet",
                 "diurnal_shape.parquet", "forecast_modes.parquet",
                 "monitors.parquet", "golden_city_hourly.csv", "meta.json"]:
        assert (FIX / name).exists(), f"fixture missing {name}"
