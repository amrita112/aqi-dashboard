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
from scripts.ingest.lib.config import TARGET_STATIONS_PATH  # noqa: E402
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


def latest_observations(client, pollutants: List[str],
                        since: date) -> Dict[Tuple[str, str], Tuple[date, float]]:
    """(monitor_id, pollutant) -> (date, mean) of the most recent day seen."""
    rows, offset = [], 0
    while True:
        r = (client.table("readings_daily")
                   .select("monitor_id, pollutant, date, mean")
                   .in_("pollutant", pollutants)
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
        })
    return rows


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--pollutants", nargs="+", default=["pm25", "aqi"])
    ap.add_argument("--horizon", type=int, default=DEFAULT_HORIZON_DAYS)
    args = ap.parse_args()

    today = datetime.now(timezone.utc).date()
    print(f"Nightly forecast for {today} (+1..+{args.horizon}), "
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

    if args.dry_run:
        print("\nDry run — nothing written.")
        return

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
