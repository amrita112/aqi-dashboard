"""
Nightly forecast: seven days ahead for every station, written to forecast_daily.

Runs after the daily rollup. Does no fitting -- the monthly refit already
produced the climatology curves, alphas and mode tables, so this job is
lookups and arithmetic and finishes in seconds.

Per station and pollutant:

  1. Find the most recent day in readings_daily. Its AGE is the pivot of the
     whole job: OpenAQ's publication lag swings between roughly 17 and 80 hours
     and individual stations go quiet for a week, so freshness is a per-station
     fact, not a global one.
  2. Anomaly = that day's value minus that day's climatology.
  3. Days 1-3: climatology for the target day + alpha x anomaly, where alpha is
     chosen for the EFFECTIVE horizon (age + horizon), because information that
     is already three days old forecasts tomorrow about as well as it forecasts
     four days out.
  4. Days 4-7: bare climatology, labelled seasonal_normal. No band -- these are
     an average, and drawing uncertainty around an average implies a prediction
     we are not making.
  5. Mode and band come from forecast_modes, keyed on the measured data age.

Stations with too little history, or with no recent observation at all, produce
climatology-only rows rather than being dropped: a station that says "here is
the seasonal normal, we have no recent reading" is more useful than one that
silently disappears from the map.

Usage (from repo root):
    python3 -m scripts.forecast.nightly_forecast
    python3 -m scripts.forecast.nightly_forecast --dry-run
    python3 -m scripts.forecast.nightly_forecast --pollutants pm25 --horizon 7

Env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from scripts.forecast.refit_params import APP_TO_ANALYSIS, MIN_HISTORY_DAYS  # noqa: E402
from scripts.ingest.lib.config import TARGET_STATIONS_PATH, ist_today  # noqa: E402
from scripts.ingest.lib.supabase_client import make_client  # noqa: E402

DEFAULT_HORIZON_DAYS = 7
FORECAST_HORIZONS = (1, 2, 3)      # beyond this it is climatology, not a forecast

# How far back to look for a usable observation. Past this the anomaly is so
# stale that every horizon scores at or below the seasonal average anyway, so
# there is nothing to gain by looking further.
MAX_OBSERVATION_AGE_DAYS = 14


def day_of_year(d: date) -> int:
    return d.timetuple().tm_yday


def load_params(client) -> Dict[Tuple[str, str], Dict[str, Any]]:
    """(monitor_id, pollutant) -> fitted parameters."""
    rows, offset = [], 0
    while True:
        r = (client.table("forecast_params").select("*")
                   .range(offset, offset + 999).execute())
        rows += r.data or []
        if not r.data or len(r.data) < 1000:
            break
        offset += 1000
    return {(r["monitor_id"], r["pollutant"]): r for r in rows}


def load_modes(client) -> Dict[Tuple[str, str, int, int], Dict[str, Any]]:
    """(city, pollutant, data_age, horizon) -> mode and band."""
    rows, offset = [], 0
    while True:
        r = (client.table("forecast_modes").select("*")
                   .range(offset, offset + 999).execute())
        rows += r.data or []
        if not r.data or len(r.data) < 1000:
            break
        offset += 1000
    return {(r["city"], r["pollutant"], r["data_age_days"], r["horizon_days"]): r
            for r in rows}


# readings_daily stores the four measured pollutants. Composite AQI is not a
# measurement, so it is never in there -- and without this it is never found,
# which silently pins every AQI forecast to seasonal_normal forever.
MEASURED_POLLUTANTS = ("pm25", "pm10", "no2", "so2")


def latest_observations(client, pollutants: List[str],
                        since: date) -> Dict[Tuple[str, str], Tuple[date, float]]:
    """(monitor_id, pollutant) -> (date, value) of the most recent day seen.

    For measured pollutants this is the stored daily mean. For 'aqi' it is
    derived the way CPCB defines NAQI: convert each pollutant's daily mean to
    its sub-index and take the max over the pollutants that station reported
    that day.
    """
    from scripts.ingest.lib.aqi_utils import compute_subindex

    rows, offset = [], 0
    while True:
        r = (client.table("readings_daily")
                   .select("monitor_id, pollutant, date, mean")
                   .in_("pollutant", list(MEASURED_POLLUTANTS))
                   .gte("date", since.isoformat())
                   .range(offset, offset + 999).execute())
        rows += r.data or []
        if not r.data or len(r.data) < 1000:
            break
        offset += 1000

    latest: Dict[Tuple[str, str], Tuple[date, float]] = {}
    for row in rows:
        key = (row["monitor_id"], row["pollutant"])
        d = date.fromisoformat(row["date"])
        if key not in latest or d > latest[key][0]:
            latest[key] = (d, float(row["mean"]))

    if "aqi" in pollutants:
        # Group by (monitor, day) so the max is taken across pollutants
        # measured on the SAME day -- mixing days would invent an AQI that
        # never occurred.
        by_day: Dict[Tuple[str, date], List[float]] = {}
        for row in rows:
            sub = compute_subindex(row["pollutant"], float(row["mean"]))
            if sub is None:
                continue
            by_day.setdefault((row["monitor_id"], date.fromisoformat(row["date"])),
                              []).append(float(sub))
        for (monitor_id, d), subs in by_day.items():
            key = (monitor_id, "aqi")
            if key not in latest or d > latest[key][0]:
                latest[key] = (d, max(subs))

    return latest


def nearest_mode(modes: Dict, city: str, pollutant: str,
                 age: int, horizon: int) -> Optional[Dict[str, Any]]:
    """Mode row for this age, falling back to the closest age that was fitted.

    forecast_modes is fitted at a handful of ages (0,1,2,3,4,5,7) rather than
    every integer, so an observation 6 days old has no exact row. Round UP to
    the next fitted age: claiming the skill of a fresher reading than we have
    would be the wrong way to be wrong.
    """
    exact = modes.get((city, pollutant, age, horizon))
    if exact:
        return exact
    candidates = sorted(a for (c, p, a, h) in modes
                        if c == city and p == pollutant and h == horizon and a >= age)
    if candidates:
        return modes.get((city, pollutant, candidates[0], horizon))
    # Older than anything fitted: treat as the stalest case we measured.
    worst = sorted((a for (c, p, a, h) in modes
                    if c == city and p == pollutant and h == horizon), reverse=True)
    return modes.get((city, pollutant, worst[0], horizon)) if worst else None


def build_station_rows(monitor_id: str, city: str, pollutant: str,
                       params: Dict[str, Any],
                       observation: Optional[Tuple[date, float]],
                       modes: Dict, today: date,
                       horizon_days: int) -> List[Dict[str, Any]]:
    """Seven rows for one station-pollutant."""
    clim = params["climatology"]

    def clim_for(d: date) -> Optional[float]:
        doy = day_of_year(d)
        v = clim[doy] if doy < len(clim) else 0.0
        return float(v) if v else None

    anomaly, based_on, age = 0.0, None, None
    if observation is not None:
        obs_date, obs_value = observation
        age = (today - obs_date).days
        base = clim_for(obs_date)
        if base is not None and age <= MAX_OBSERVATION_AGE_DAYS:
            anomaly, based_on = obs_value - base, obs_date
        else:
            age = None

    # No usable recent reading, or too little history to trust the curve:
    # serve the seasonal normal and say so.
    degraded = (age is None) or (params["history_days"] < MIN_HISTORY_DAYS)

    rows: List[Dict[str, Any]] = []
    for h in range(1, horizon_days + 1):
        target = today + timedelta(days=h)
        base = clim_for(target)
        if base is None:
            continue

        if degraded or h not in FORECAST_HORIZONS:
            value, mode, band50, band80 = base, "seasonal_normal", None, None
            model = "climatology"
        else:
            # Alpha for the EFFECTIVE horizon: an observation `age` days old
            # forecasting `h` days out is really an (age + h)-step problem.
            effective = min(age + h, 3)
            alpha = float(params[f"alpha_h{effective}"])
            m = nearest_mode(modes, city, pollutant, age, h)
            mode = m["mode"] if m else "outlook"

            if mode == "seasonal_normal":
                # The measured skill at this data age is no better than the
                # seasonal average, so SERVE the seasonal average. Carrying the
                # anomaly forward while labelling the row "seasonal_normal"
                # would put a number on screen that contradicts its own label
                # -- the exact dishonesty this mode exists to prevent.
                value, band50, band80 = base, None, None
                model = "climatology"
            else:
                value = max(base + alpha * anomaly, 0.0)  # a negative forecast is not one
                band50 = m.get("band_p50") if m else None
                band80 = m.get("band_p80") if m else None
                model = params["model"]

        rows.append({
            "monitor_id": monitor_id,
            "pollutant": pollutant,
            "target_date": target.isoformat(),
            "horizon_days": h,
            "value": round(float(value), 2),
            "band_p50": band50,
            "band_p80": band80,
            "mode": mode,
            "model": model,
            "based_on_date": based_on.isoformat() if based_on else None,
            "data_age_days": age,
            "computed_at": datetime.now(timezone.utc).isoformat(),
            # Dropped before writing; only used to match a bias decision.
            "city_key": city,
        })
    return rows


BIAS_HISTORY_DAYS = 21


def load_scored_history(client, pollutants: List[str], since: date
                        ) -> Tuple[List[Dict[str, Any]], Dict[Tuple[str, str], float]]:
    """Past forecasts and what actually happened, for learning the bias.

    Returns the forecasts (carrying value_raw where one was stored) and the
    observed daily value per (monitor_id, date) in the same shape the forecasts
    are keyed by, so city_day_errors can line them up.
    """
    from scripts.ingest.lib.aqi_utils import compute_subindex

    fc, offset = [], 0
    while True:
        r = (client.table("forecast_daily")
                   .select("monitor_id, pollutant, target_date, value, value_raw")
                   .eq("horizon_days", 1)
                   .in_("pollutant", pollutants)
                   .gte("target_date", since.isoformat())
                   .range(offset, offset + 999).execute())
        fc += r.data or []
        if not r.data or len(r.data) < 1000:
            break
        offset += 1000

    rows, offset = [], 0
    while True:
        r = (client.table("readings_daily")
                   .select("monitor_id, pollutant, date, mean")
                   .in_("pollutant", list(MEASURED_POLLUTANTS))
                   .gte("date", since.isoformat())
                   .range(offset, offset + 999).execute())
        rows += r.data or []
        if not r.data or len(r.data) < 1000:
            break
        offset += 1000

    # Same construction as latest_observations: sub-index per pollutant, max
    # across them for AQI. Deriving it differently here would make the measured
    # bias an artefact of the two definitions disagreeing.
    actuals: Dict[Tuple[str, str], float] = {}
    by_day: Dict[Tuple[str, str], Dict[str, float]] = {}
    for r in rows:
        if r["mean"] is None:
            continue
        key = (r["monitor_id"], r["date"])
        by_day.setdefault(key, {})[r["pollutant"]] = float(r["mean"])
    for (mid, d), pol in by_day.items():
        if "pm25" in pol:
            actuals[(mid, d)] = pol["pm25"] if "pm25" in pollutants else None
        subs = [compute_subindex(p, v) for p, v in pol.items()]
        subs = [x for x in subs if x is not None]
        if subs:
            actuals[(mid, d)] = max(subs)
    return fc, actuals


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--pollutants", nargs="+", default=["pm25", "aqi"])
    ap.add_argument("--horizon", type=int, default=DEFAULT_HORIZON_DAYS)
    args = ap.parse_args()

    # IST, not UTC. target_date, readings_daily.date and the day-of-year the
    # climatology is indexed by are all Indian calendar days -- see the
    # time-base note in scripts/ingest/lib/config.py. This happened to give the
    # right answer while the cron ran at 05:30 UTC (11:00 IST, same date), and
    # would have silently gone a day out if it were ever moved past 18:30 UTC.
    today = ist_today()
    print(f"Nightly forecast for {today} IST (+1..+{args.horizon}), "
          f"pollutants={args.pollutants}, dry_run={args.dry_run}")

    client = make_client()
    manifest = json.loads(TARGET_STATIONS_PATH.read_text())
    city_of = {s["monitor_id"]: APP_TO_ANALYSIS.get(s["city"], s["city"])
               for s in manifest["stations"]}

    params = load_params(client)
    modes = load_modes(client)
    print(f"  loaded {len(params)} param rows, {len(modes)} mode rows")
    if not params:
        raise SystemExit("forecast_params is empty — run refit_params first.")

    observations = latest_observations(
        client, args.pollutants, today - timedelta(days=MAX_OBSERVATION_AGE_DAYS))
    print(f"  {len(observations)} station-pollutants have a recent observation")

    out_rows: List[Dict[str, Any]] = []
    stats = {"forecast": 0, "outlook": 0, "seasonal_normal": 0}
    ages: List[int] = []

    for station in manifest["stations"]:
        monitor_id = station["monitor_id"]
        city = city_of.get(monitor_id)
        for pollutant in args.pollutants:
            p = params.get((monitor_id, pollutant))
            if p is None:
                continue
            obs = observations.get((monitor_id, pollutant))
            rows = build_station_rows(monitor_id, city, pollutant, p, obs,
                                      modes, today, args.horizon)
            out_rows += rows
            for r in rows:
                stats[r["mode"]] = stats.get(r["mode"], 0) + 1
            if rows and rows[0]["data_age_days"] is not None:
                ages.append(rows[0]["data_age_days"])

    print(f"\n  {len(out_rows)} forecast rows")
    for mode, n in stats.items():
        print(f"    {mode:<16} {n:>6}  ({n / max(len(out_rows), 1):.0%})")
    if ages:
        print(f"  observation age: median {int(np.median(ages))}d, "
              f"min {min(ages)}d, max {max(ages)}d")
    else:
        print("  no station had a usable recent observation — all seasonal_normal")

    # ── BIAS CORRECTION ──────────────────────────────────────────────────────
    # Learned from how the last three weeks of our own +1 day forecasts scored
    # against what was measured, and applied per city only where it has been
    # helping. See scripts/forecast/bias_correction.py for why this exists and
    # why it polices itself.
    hist_fc, hist_actual = load_scored_history(
        client, args.pollutants, today - timedelta(days=BIAS_HISTORY_DAYS))
    errors = city_day_errors(hist_fc, hist_actual, city_of)
    decisions = {k: decide(v, today) for k, v in errors.items()}

    print(f"\n  bias correction, from {len(hist_fc)} scored forecasts:")
    applied_n = 0
    for (city, pollutant), d in sorted(decisions.items()):
        mark = "APPLY " if d["applied"] else "skip  "
        print(f"    {mark}{city:<12}{pollutant:<6}offset {d['offset']:+8.2f}   {d['reason']}")
    for r in out_rows:
        d = decisions.get((r["city_key"], r["pollutant"]))
        if not d or not d["applied"]:
            continue
        raw = r["value"]
        r["value_raw"] = raw
        r["value"] = round(apply_offset(raw, d["offset"]), 2)
        applied_n += 1
    print(f"    corrected {applied_n} of {len(out_rows)} rows")

    # city_key exists only to join rows to decisions; it is not a column.
    for r in out_rows:
        r.pop("city_key", None)

    if args.dry_run:
        print("\nDry run — nothing written.")
        return

    bias_rows = [{
        "city": city, "pollutant": pollutant,
        "offset_value": d["offset"], "applied": d["applied"],
        "reason": d["reason"], "n_days": d["n_days"],
        "mae_raw": d["mae_raw"], "mae_corrected": d["mae_corrected"],
        "computed_at": datetime.now(timezone.utc).isoformat(),
    } for (city, pollutant), d in decisions.items()]
    if bias_rows:
        (client.table("forecast_bias")
               .upsert(bias_rows, on_conflict="city,pollutant").execute())
        print(f"  forecast_bias: {len(bias_rows)} rows upserted")

    written = 0
    for i in range(0, len(out_rows), 500):
        chunk = out_rows[i:i + 500]
        (client.table("forecast_daily")
               .upsert(chunk, on_conflict="monitor_id,pollutant,target_date")
               .execute())
        written += len(chunk)
    print(f"\n  forecast_daily: {written} rows upserted")


if __name__ == "__main__":
    main()
