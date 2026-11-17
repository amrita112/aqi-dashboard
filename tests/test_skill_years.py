"""The served model and label are measured on several held-out years, and the
median across years decides (Nov 2026; before that, one year: 2024).

What must hold:
  - a year is tested only with two full years of data before it, and only once
    its season has finished;
  - each year is summarised exactly as the old single-year test summarised it
    (median station), so the per-year numbers are comparable;
  - the served skill is the median of those years, and the label follows it;
  - the band is pooled over the years, not a median of yearly bands.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.forecast import baselines as B  # noqa: E402

IDX = pd.date_range("2016-01-01", "2024-12-31", freq="D")


def seasonal_ar(seed=0, phi=0.6, swing=80.0, noise=15.0, idx=IDX):
    rng = np.random.default_rng(seed)
    seasonal = 120 + swing * np.cos(2 * np.pi * (idx.dayofyear - 330) / 365.25)
    anom = np.zeros(len(idx))
    for i in range(1, len(idx)):
        anom[i] = phi * anom[i - 1] + rng.normal(0, noise)
    return pd.Series(seasonal + anom, index=idx, name="X")


def frame(series_by_station, city="X"):
    """The refit's (city, station, d, v) table."""
    return pd.concat([pd.DataFrame({"city": city, "station": st, "d": s.index, "v": s.values})
                      for st, s in series_by_station.items()], ignore_index=True)


# ── which years are tested ───────────────────────────────────────────────────

def test_needs_two_full_prior_years():
    s = seasonal_ar()
    years = B.eligible_test_years(s, last_day=s.index.max())
    assert years[0] == 2018                     # 2016 and 2017 before it
    assert years == list(range(2018, 2025))


def test_a_stub_year_is_not_a_full_year():
    """A station starting in November 2016 has two calendar years before 2018,
    but 2016 is two months, not a year of training."""
    s = seasonal_ar()
    s = s[s.index >= "2016-11-01"]
    assert 2016 not in B.full_years(s)
    assert B.eligible_test_years(s, last_day=s.index.max())[0] == 2019


def test_gaps_can_make_a_year_not_full():
    s = seasonal_ar()
    s[(s.index.year == 2017) & (s.index.month <= 5)] = np.nan   # ~150 days lost
    assert 2017 not in B.full_years(s, min_days=240)
    assert 2017 in B.full_years(s, min_days=200)                 # configurable
    assert B.eligible_test_years(s, last_day=s.index.max())[0] == 2019


def test_an_unfinished_season_is_not_tested():
    """Data to mid-November 2024: the 2024 season is still running."""
    s = seasonal_ar()
    s = s[s.index <= "2024-11-15"]
    assert 2024 not in B.eligible_test_years(s, last_day=s.index.max())
    assert 2023 in B.eligible_test_years(s, last_day=s.index.max())


def test_last_day_is_the_whole_history_not_the_station():
    """A station that stopped in March 2024 can still be tested on 2023, and
    is not tested on 2024 (too few season days), whatever its own last day."""
    s = seasonal_ar()
    s = s[s.index <= "2024-03-31"]
    years = B.eligible_test_years(s, last_day=pd.Timestamp("2026-11-14"))
    assert 2023 in years and 2024 not in years


def test_year_range_and_prior_years_are_configurable():
    s = seasonal_ar()
    assert B.eligible_test_years(s, s.index.max(), year_range=(2020, 2022)) == [2020, 2021, 2022]
    assert B.eligible_test_years(s, s.index.max(), min_prior_years=4)[0] == 2020


# ── how the years are combined ───────────────────────────────────────────────

@pytest.fixture(scope="module")
def three_stations():
    return {f"s{i}": seasonal_ar(seed=i) for i in range(3)}


@pytest.fixture(scope="module")
def result(three_stations):
    return B.station_skill_years(frame(three_stations), "X",
                                 data_ages=(0, 3), horizons=(1, 2))


def test_each_year_is_summarised_like_the_single_year_test(three_stations, result):
    """per_year for 2022 is the old station_model_skill on 2022."""
    old = B.station_model_skill(frame(three_stations), "X", 2022,
                                data_ages=(0, 3), horizons=(1, 2))
    new = result["per_year"][result["per_year"].test_year == 2022]
    m = old.merge(new, on=["data_age_days", "horizon_days", "model"], suffixes=("_old", "_new"))
    assert len(m) == len(old) == 8
    for col in ("skill_pct", "mae", "clim_mae", "band_p50", "band_p80"):
        assert np.allclose(m[f"{col}_old"], m[f"{col}_new"]), col


def test_served_skill_is_the_median_across_years(result):
    py, summary = result["per_year"], result["summary"]
    for _, r in summary.iterrows():
        years = py[(py.data_age_days == r.data_age_days) & (py.horizon_days == r.horizon_days)
                   & (py.model == r.model)]
        assert r.skill_pct == pytest.approx(years.skill_pct.median())
        assert r.n_years == len(years) == 7
    assert summary.test_years.iat[0] == "2018,2019,2020,2021,2022,2023,2024"


def test_label_and_model_follow_the_median(result):
    modes = result["modes"]
    assert len(modes) == 4                      # 2 ages x 2 horizons
    for _, r in modes.iterrows():
        rows = result["summary"][(result["summary"].data_age_days == r.data_age_days)
                                 & (result["summary"].horizon_days == r.horizon_days)]
        assert r.skill_pct == rows.skill_pct.max()
        want = ("forecast" if r.skill_pct >= 20 else
                "outlook" if r.skill_pct >= B.MIN_USEFUL_SKILL_PCT else "seasonal_normal")
        assert r["mode"] == want


def test_band_is_pooled_over_years():
    """One station: the band is the quantile of ALL its years' relative errors."""
    s = seasonal_ar(seed=7)
    res = B.station_skill_years(frame({"only": s}), "X", data_ages=(1,), horizons=(1,),
                                min_stations_per_year=1)
    rel = []
    for y in range(2018, 2025):
        t = B.model_skill_table(s.rename("X"), y, data_ages=(1,), horizons=(1,), keep_residuals=True)
        rel.append(t[t.model == "blend"].rel_err.iat[0])
    want = np.percentile(np.concatenate(rel), 80)
    got = res["summary"].query("model == 'blend'").band_p80.iat[0]
    assert got == pytest.approx(want)


def test_a_year_needs_enough_stations(three_stations):
    """With one station starting in 2020, its early years cannot stand for the
    city when two stations are required."""
    late = {"a": seasonal_ar(seed=1)[lambda x: x.index >= "2020-01-01"],
            "b": seasonal_ar(seed=2)}
    res = B.station_skill_years(frame(late), "X", data_ages=(1,), horizons=(1,))
    assert sorted(res["per_year"].test_year.unique()) == [2022, 2023, 2024]
    res1 = B.station_skill_years(frame(late), "X", data_ages=(1,), horizons=(1,),
                                 min_stations_per_year=1)
    assert sorted(res1["per_year"].test_year.unique())[0] == 2018


def test_no_eligible_year_gives_an_empty_table():
    short = seasonal_ar()[lambda x: x.index >= "2023-06-01"]
    res = B.station_skill_years(frame({"a": short}), "X")
    assert res["modes"].empty and res["summary"].empty


def test_city_fallback_uses_the_same_rule():
    s = seasonal_ar(seed=3)
    res = B.city_skill_years(s, data_ages=(1,), horizons=(1,))
    assert res["summary"].n_years.iat[0] == 7


def test_refit_stores_the_multi_year_table(three_stations):
    """refit_params.fit_city's modes are station_skill_years' modes."""
    from scripts.forecast import refit_params as rp
    st = frame(three_stations, city="Pune")
    daily = pd.DataFrame({"city_name": "Pune", "d": IDX, "pm25": seasonal_ar(seed=9).values,
                          "n_stations": 3})
    fit = rp.fit_city("Pune", "pm25", daily, None, None, station_hist=st)
    want = B.station_skill_years(st, "Pune")["modes"]
    assert fit["modes"][["data_age_days", "horizon_days", "model", "mode"]].equals(
        want[["data_age_days", "horizon_days", "model", "mode"]])
    assert fit["modes"].n_years.min() == 7


# ── per-city first test year (Delhi from 2019, decided 17 Nov 2026) ─────────

def test_delhi_starts_at_2019_by_default():
    assert B.SKILL_FIRST_TEST_YEAR_BY_CITY == {"Delhi": 2019}


def test_city_range_combines_with_the_global_range():
    first = {"Delhi": 2019}
    assert B.city_test_year_range("Delhi", None, first) == (2019, 9999)
    assert B.city_test_year_range("Delhi", (2017, 2023), first) == (2019, 2023)
    assert B.city_test_year_range("Delhi", (2020, 2023), first) == (2020, 2023)
    assert B.city_test_year_range("Pune", (2017, 2023), first) == (2017, 2023)
    assert B.city_test_year_range("Pune", None, first) is None
    lo, hi = B.city_test_year_range("Delhi", (2016, 2018), first)
    assert lo > hi                              # empty: nothing tested


def test_delhi_skill_years_start_at_2019_other_cities_unchanged(three_stations):
    delhi = B.station_skill_years(frame(three_stations, city="Delhi"), "Delhi",
                                  data_ages=(1,), horizons=(1,))
    assert delhi["summary"].test_years.iat[0] == "2019,2020,2021,2022,2023,2024"
    assert delhi["eligible"].test_year.min() == 2019
    pune = B.station_skill_years(frame(three_stations, city="Pune"), "Pune",
                                 data_ages=(1,), horizons=(1,))
    assert pune["summary"].test_years.iat[0].startswith("2018,")


def test_delhi_combined_with_global_range_and_override(three_stations):
    st = frame(three_stations, city="Delhi")
    res = B.station_skill_years(st, "Delhi", data_ages=(1,), horizons=(1,),
                                year_range=(2017, 2021))
    assert res["summary"].test_years.iat[0] == "2019,2020,2021"
    off = B.station_skill_years(st, "Delhi", data_ages=(1,), horizons=(1,),
                                first_test_year_by_city={})
    assert off["summary"].test_years.iat[0].startswith("2018,")


def test_delhi_city_fallback_also_starts_at_2019():
    s = seasonal_ar(seed=3).rename("Delhi")
    res = B.city_skill_years(s, data_ages=(1,), horizons=(1,))
    assert res["summary"].test_years.iat[0].split(",")[0] == "2019"


@pytest.mark.parametrize("pollutant", ["pm25", "aqi"])
def test_refit_prints_delhi_test_years_from_2019(three_stations, pollutant, capsys):
    from scripts.forecast import refit_params as rp
    st = frame(three_stations, city="Delhi")
    series = seasonal_ar(seed=9).values
    daily = pd.DataFrame({"city_name": "Delhi", "d": IDX, "pm25": series, "n_stations": 3})
    daily_aqi = pd.DataFrame({"city": "Delhi", "d": IDX, "aqi": series})
    fit = rp.fit_city("Delhi", pollutant, daily, daily_aqi, None, station_hist=st)
    out = capsys.readouterr().out
    assert f"Delhi/{pollutant}: skill measured on test years 2019,2020," in out
    assert fit["modes"].n_years.min() == 6
