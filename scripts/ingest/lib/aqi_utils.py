"""
AQI utility functions — Python port of lib/aqi-utils.ts.

Both implementations read from lib/aqi-config.json (the single source of truth
for AQI scales, breakpoints, and unit conversions). Matching APIs make it
easier to spot a bug in either language against the other.

Supports two scales via an optional `scale` argument on every function,
defaulting to `DEFAULT_SCALE` ("naqi"):
  - NAQI (India CPCB): Good / Satisfactory / Moderate / Poor / Very Poor / Severe
  - EPA  (US):         Good / Moderate / USG / Unhealthy / Very Unhealthy / Hazardous

All computations use the *instantaneous* reading — no rolling time averaging.
Consumer real-time apps universally use this simplification; regulatory
24-hour averaging answers a different question (chronic exposure) than our
product does (immediate decision support).
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

# Resolve config path: <project-root>/lib/aqi-config.json
# __file__ = .../scripts/ingest/lib/aqi_utils.py, so parents[3] is the project root.
_CONFIG_PATH = Path(__file__).resolve().parents[3] / "lib" / "aqi-config.json"

with _CONFIG_PATH.open("r", encoding="utf-8") as _f:
    _CONFIG: Dict[str, Any] = json.load(_f)

DEFAULT_SCALE: str = _CONFIG["default_scale"]
CANONICAL_UNITS: Dict[str, str] = _CONFIG["canonical_units"]

_SCALES = _CONFIG["scales"]
_CATEGORIES: Dict[str, List[Dict[str, Any]]] = {
    name: s["categories"] for name, s in _SCALES.items()
}
_DARK_LABELS: Dict[str, List[str]] = {
    name: s["dark_labels"] for name, s in _SCALES.items()
}
_BREAKPOINTS: Dict[str, Dict[str, List[Dict[str, float]]]] = {
    name: s["breakpoints"] for name, s in _SCALES.items()
}
_PPB_TO_UGM3: Dict[str, float] = _CONFIG["unit_conversions"]["ppb_to_ugm3"]
_PPM_TO_MGM3: Dict[str, float] = _CONFIG["unit_conversions"]["ppm_to_mgm3"]


# ─── Unit conversion ────────────────────────────────────────────────────────

def convert_to_canonical(
    pollutant: str, value: float, unit: str
) -> Optional[float]:
    """Convert a raw measurement to the canonical unit expected by compute_subindex.

    Canonical units (see aqi-config.json -> canonical_units):
      pm25, pm10, o3, no2, so2 -> µg/m³
      co                       -> mg/m³

    Returns None when the unit is unrecognized for the given pollutant — caller
    should drop the measurement and log the mismatch rather than silently
    feeding a wrong-unit value into the sub-index formula.

    Ingest sources publish measurements in various units. OpenAQ, for example,
    publishes CO, NO2, and SO2 in ppb. Feeding raw ppb values into
    compute_subindex() produces sub-indices off by ~1000× — a moderate CO
    reading of 500 ppb (~= 0.57 mg/m³, "Good") would compute as if it were
    500 mg/m³ = "Severe". Always run raw ingest data through this function first.
    """
    canonical = CANONICAL_UNITS.get(pollutant)
    if canonical is None or value is None:
        return None
    if unit == canonical:
        return float(value)

    # Particulate / CO mass unit shortcuts
    if canonical == "µg/m³" and unit == "mg/m³":
        return value * 1000
    if canonical == "mg/m³" and unit == "µg/m³":
        return value / 1000

    # Gas -> µg/m³ (NO2, SO2, O3)
    ppb_factor = _PPB_TO_UGM3.get(pollutant)
    if canonical == "µg/m³" and ppb_factor is not None:
        if unit == "ppb":
            return value * ppb_factor
        if unit == "ppm":
            return value * ppb_factor * 1000

    # Gas -> mg/m³ (CO)
    ppm_factor = _PPM_TO_MGM3.get(pollutant)
    if canonical == "mg/m³" and ppm_factor is not None:
        if unit == "ppm":
            return value * ppm_factor
        if unit == "ppb":
            return value * ppm_factor / 1000

    return None


# ─── Category / label / color lookups ───────────────────────────────────────

def get_aqi_category(value: float, scale: Optional[str] = None) -> Dict[str, Any]:
    """Return the category dict {label, color, min, max} for an AQI value."""
    if scale is None:
        scale = DEFAULT_SCALE
    table = _CATEGORIES[scale]
    for cat in table:
        if cat["min"] <= value <= cat["max"]:
            return cat
    # Defensive: out-of-range values fall back to the worst (last) category.
    return table[-1]


def get_aqi_color(value: float, scale: Optional[str] = None) -> str:
    return get_aqi_category(value, scale)["color"]


def get_aqi_label(value: float, scale: Optional[str] = None) -> str:
    return get_aqi_category(value, scale)["label"]


def get_aqi_text_color(value: float, scale: Optional[str] = None) -> str:
    """Contrasting text color for a given AQI value's background."""
    if scale is None:
        scale = DEFAULT_SCALE
    return "#ffffff" if get_aqi_label(value, scale) in _DARK_LABELS[scale] else "#000000"


# ─── Sub-index + composite AQI ──────────────────────────────────────────────

def compute_subindex(
    pollutant: str, value: float, scale: Optional[str] = None
) -> int:
    """Compute the per-pollutant AQI sub-index for one measurement.

    IMPORTANT: `value` MUST be in `CANONICAL_UNITS[pollutant]` (µg/m³ for most,
    mg/m³ for CO). Run raw ingest values through `convert_to_canonical()` first
    or sub-indices will be wildly wrong (typically off by ~1000× for gas ppb).

    Values above the standard scale (top of the highest breakpoint band) are
    handled by extrapolating linearly using that band's slope, then capping at
    1000 to match the DB CHECK on `readings.aqi_value`. This preserves severity
    information for extreme events (e.g., Delhi winter PM2.5 > 500 µg/m³).
    """
    if scale is None:
        scale = DEFAULT_SCALE
    if value < 0:
        raise ValueError(
            f"Cannot compute sub-index for negative concentration: {pollutant} = {value}"
        )
    scale_bps = _BREAKPOINTS[scale]
    if pollutant not in scale_bps:
        raise KeyError(f"No breakpoints for pollutant {pollutant!r} in scale {scale!r}")
    table = scale_bps[pollutant]
    # Find matching band, else extrapolate using the top band for above-scale values.
    bp = next(
        (b for b in table if b["c_lo"] <= value <= b["c_hi"]),
        table[-1],
    )
    sub_index = (
        ((bp["i_hi"] - bp["i_lo"]) / (bp["c_hi"] - bp["c_lo"]))
        * (value - bp["c_lo"])
        + bp["i_lo"]
    )
    # Match JavaScript's Math.round (rounds .5 away from zero) rather than
    # Python's built-in `round()` (banker's rounding). Sub-indices are always
    # >= 0, so floor(x + 0.5) is safe.
    return min(1000, math.floor(sub_index + 0.5))


def compute_aqi_from_measurements(
    measurements: Iterable[Dict[str, Any]], scale: Optional[str] = None
) -> int:
    """Compute composite AQI (max of per-pollutant sub-indices).

    `measurements`: iterable of dicts with at least 'pollutant' and 'value' keys.
    Values must already be in canonical units.
    Raises ValueError if given an empty iterable.
    """
    if scale is None:
        scale = DEFAULT_SCALE
    ms = list(measurements)
    if not ms:
        raise ValueError("Cannot compute AQI from an empty measurements sequence")
    return max(
        compute_subindex(m["pollutant"], m["value"], scale) for m in ms
    )
