"""
Python mirror of lib/aqi-utils.test.ts.

Both suites read the same lib/aqi-config.json, so any change to that file
should either leave both suites passing or break both — never just one.
If they diverge, one of the implementations has drifted from the shared config.

Run:  pytest scripts/ingest/lib/
"""

import pytest

from scripts.ingest.lib.aqi_utils import (
    compute_aqi_from_measurements,
    compute_subindex,
    convert_to_canonical,
    get_aqi_category,
    get_aqi_color,
    get_aqi_label,
    get_aqi_text_color,
)


# ─── get_aqi_category (default = NAQI) ──────────────────────────────────────

@pytest.mark.parametrize("value,label", [
    (0,   "Good"),
    (50,  "Good"),
    (51,  "Satisfactory"),
    (100, "Satisfactory"),
    (101, "Moderate"),
    (200, "Moderate"),
    (201, "Poor"),
    (300, "Poor"),
    (301, "Very Poor"),
    (400, "Very Poor"),
    (401, "Severe"),
    (500, "Severe"),
])
def test_naqi_category_boundaries(value, label):
    assert get_aqi_category(value)["label"] == label


def test_naqi_out_of_range_falls_back_to_severe():
    assert get_aqi_category(9999)["label"] == "Severe"


# ─── get_aqi_category with EPA scale ────────────────────────────────────────

@pytest.mark.parametrize("value,label", [
    (50,  "Good"),
    (75,  "Moderate"),
    (125, "Unhealthy for Sensitive Groups"),
    (175, "Unhealthy"),
    (250, "Very Unhealthy"),
    (400, "Hazardous"),
])
def test_epa_category_boundaries(value, label):
    assert get_aqi_category(value, "epa")["label"] == label


# ─── colors ─────────────────────────────────────────────────────────────────

def test_naqi_colors_default_scale():
    assert get_aqi_color(25)  == "#00b050"   # Good (dark green)
    assert get_aqi_color(75)  == "#92d050"   # Satisfactory (light green)
    assert get_aqi_color(450) == "#7e0023"   # Severe (maroon)


def test_epa_colors_explicit_scale():
    assert get_aqi_color(25,  "epa") == "#00e400"   # EPA Good (brighter green)
    assert get_aqi_color(75,  "epa") == "#ffff00"   # EPA Moderate (yellow)
    assert get_aqi_color(400, "epa") == "#7e0023"   # EPA Hazardous


# ─── labels ─────────────────────────────────────────────────────────────────

def test_naqi_labels_default_scale():
    assert get_aqi_label(75)  == "Satisfactory"
    assert get_aqi_label(175) == "Moderate"


def test_epa_labels_explicit_scale():
    assert get_aqi_label(75,  "epa") == "Moderate"
    assert get_aqi_label(175, "epa") == "Unhealthy"


# ─── text color ─────────────────────────────────────────────────────────────

def test_naqi_text_color_light_bands():
    assert get_aqi_text_color(25)  == "#000000"   # Good
    assert get_aqi_text_color(75)  == "#000000"   # Satisfactory
    assert get_aqi_text_color(150) == "#000000"   # Moderate


def test_naqi_text_color_dark_bands():
    assert get_aqi_text_color(250) == "#ffffff"   # Poor
    assert get_aqi_text_color(350) == "#ffffff"   # Very Poor
    assert get_aqi_text_color(450) == "#ffffff"   # Severe


def test_epa_text_color_switches_correctly():
    # AQI 250 is "Poor" (NAQI, dark) but "Very Unhealthy" (EPA, also dark)
    assert get_aqi_text_color(250, "epa") == "#ffffff"
    # AQI 125 is "Moderate" (NAQI, light) but "USG" (EPA, light)
    assert get_aqi_text_color(125, "epa") == "#000000"


# ─── compute_subindex (NAQI, default scale) ─────────────────────────────────

@pytest.mark.parametrize("value,expected", [
    (30,  50),   # Good boundary
    (60,  100),  # Satisfactory boundary
    (90,  200),  # Moderate boundary
    (120, 300),  # Poor boundary
    (250, 400),  # Very Poor boundary
])
def test_naqi_pm25_boundary_values(value, expected):
    assert compute_subindex("pm25", value) == expected


def test_naqi_pm25_interpolates_inside_a_band():
    # Mid-Satisfactory band (30–60 → 51–100):
    # value=45 → 51 + (49/30)*15 = 75.5 → 76
    assert compute_subindex("pm25", 45) == 76
    # Mid-Moderate band (60–90 → 101–200):
    # value=75 → 101 + (99/30)*15 = 150.5 → 151
    assert compute_subindex("pm25", 75) == 151


def test_naqi_extrapolates_above_top_band_and_caps_at_1000():
    assert compute_subindex("pm25", 500) == 500          # top of standard scale
    # Above scale: last band is (250-500 → 401-500), slope 99/250 = 0.396.
    # value = 1500 → 401 + 0.396 * (1500-250) = 401 + 495 = 896
    assert compute_subindex("pm25", 1500) == 896
    # Very extreme concentration would extrapolate above 1000; capped at 1000.
    assert compute_subindex("pm25", 3000) == 1000


def test_naqi_pm10_boundary_values():
    assert compute_subindex("pm10", 50)  == 50
    assert compute_subindex("pm10", 100) == 100
    assert compute_subindex("pm10", 250) == 200
    assert compute_subindex("pm10", 350) == 300


def test_naqi_co_expects_mg_per_m3_not_ug_per_m3():
    # These values are in mg/m³ per the canonical unit table.
    assert compute_subindex("co", 1.0) == 50
    assert compute_subindex("co", 2.0) == 100
    assert compute_subindex("co", 10)  == 200


def test_negative_concentration_raises():
    with pytest.raises(ValueError, match="negative"):
        compute_subindex("pm25", -5)


# ─── compute_subindex (EPA scale sanity) ────────────────────────────────────

def test_epa_pm25_matches_boundary_values():
    # Post-2024 EPA revision (Good tops out at 9.0)
    assert compute_subindex("pm25",  9.0, "epa") == 50
    assert compute_subindex("pm25", 35.4, "epa") == 100
    assert compute_subindex("pm25", 55.4, "epa") == 150


def test_naqi_and_epa_give_very_different_answers_for_same_pm25():
    # PM2.5 = 60 is the design-doc example:
    # NAQI: 100 (Satisfactory) — India tolerates more particulate
    # EPA:  ~156 (Unhealthy)   — US EPA is stricter
    assert compute_subindex("pm25", 60) == 100
    assert compute_subindex("pm25", 60, "epa") > 150


# ─── compute_aqi_from_measurements ──────────────────────────────────────────

def test_composite_returns_single_sub_index_for_one_pollutant():
    assert compute_aqi_from_measurements([{"pollutant": "pm25", "value": 60}]) == 100


def test_composite_returns_max_of_sub_indices():
    # pm25=60 → 100, pm10=50 → 50, no2=40 → 50. Max = 100.
    composite = compute_aqi_from_measurements([
        {"pollutant": "pm25", "value": 60},
        {"pollutant": "pm10", "value": 50},
        {"pollutant": "no2",  "value": 40},
    ])
    assert composite == 100


def test_composite_picks_worst_pollutant_not_average():
    # pm25=90 → 200 dominates even if o3 is low.
    composite = compute_aqi_from_measurements([
        {"pollutant": "pm25", "value": 90},
        {"pollutant": "o3",   "value": 30},
    ])
    assert composite == 200


def test_composite_empty_input_raises():
    with pytest.raises(ValueError, match="empty"):
        compute_aqi_from_measurements([])


def test_composite_honours_scale_argument():
    # Under NAQI, pm25=60 → 100. Under EPA, > 150.
    naqi = compute_aqi_from_measurements([{"pollutant": "pm25", "value": 60}])
    epa  = compute_aqi_from_measurements([{"pollutant": "pm25", "value": 60}], "epa")
    assert naqi == 100
    assert epa  > 150


# ─── convert_to_canonical ───────────────────────────────────────────────────

def test_convert_returns_value_unchanged_when_unit_matches():
    assert convert_to_canonical("pm25", 45,  "µg/m³") == 45
    assert convert_to_canonical("pm10", 100, "µg/m³") == 100
    assert convert_to_canonical("o3",   80,  "µg/m³") == 80
    assert convert_to_canonical("co",   1.5, "mg/m³") == 1.5


def test_convert_ugm3_and_mgm3_shortcut():
    assert convert_to_canonical("co",   1500, "µg/m³") == 1.5
    assert convert_to_canonical("pm25", 1.5,  "mg/m³") == 1500


def test_convert_ppb_to_ugm3_for_no2_so2_o3():
    # 100 ppb × molar-mass factor at 25 °C, 1 atm
    assert convert_to_canonical("no2", 100, "ppb") == pytest.approx(188, abs=1)  # 46.01 / 24.45
    assert convert_to_canonical("so2", 100, "ppb") == pytest.approx(262, abs=1)  # 64.07 / 24.45
    assert convert_to_canonical("o3",  100, "ppb") == pytest.approx(196, abs=1)  # 48.00 / 24.45


def test_convert_ppb_to_mgm3_for_co_the_openaq_bug_case():
    # 500 ppb CO = 0.5725 mg/m³ → NAQI ~29 (Good).
    # Without this conversion, treating 500 ppb as 500 mg/m³ would give
    # NAQI 500 (Severe) — off by ~1000× and every CO reading would look extreme.
    canonical = convert_to_canonical("co", 500, "ppb")
    assert canonical == pytest.approx(0.5725, abs=0.001)
    # Sanity: sub-index on the canonical value is Good, not Severe.
    assert compute_subindex("co", canonical) < 50


def test_convert_ppm_to_canonical():
    # 1 ppm NO2 = 1.88 mg/m³ = 1880 µg/m³
    assert convert_to_canonical("no2", 1, "ppm") == pytest.approx(1880, abs=1)
    # 1 ppm CO  = 1.145 mg/m³
    assert convert_to_canonical("co",  1, "ppm") == pytest.approx(1.145, abs=0.001)


def test_convert_returns_none_for_unrecognized_units():
    assert convert_to_canonical("pm25", 45,  "grains/liter") is None
    assert convert_to_canonical("no2",  100, "ppq") is None
