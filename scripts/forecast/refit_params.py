"""
Monthly refit: climatology, alpha, diurnal shape, bands and serving modes.

Reads years of history and writes four small tables. Expensive, and does not
need to run often -- one more month barely moves a curve built from five years,
so monthly is plenty. The nightly job then does only lookups and arithmetic.

What gets fitted, and the reasoning behind each choice:

  climatology    Smoothed day-of-year mean, per station and pollutant. Stored
                 as a 366-element array rather than 366 rows.

  alpha          The anomaly-carry weight, fitted PER CITY rather than per
                 station. Not a shortcut: averaging per-station forecasts only
                 equals forecasting the k-station aggregate -- the thing the
                 backtest validated -- when alpha is shared. Measured, a shared
                 alpha leaves a 0.5-1.3 ug/m3 gap; per-station alpha doubles it.

  diurnal_shape  Ratio of each hour to that day's mean, per CITY. Multiplying a
                 daily forecast by this is what turns 7 numbers into 168, and
                 it is what answers "when should I go out".

  modes          Measured skill for every (data age, horizon) pair, and the
                 mode that follows. This is what lets the app degrade honestly
                 when OpenAQ is behind, which it frequently is.

Usage (from repo root):
    python3 -m scripts.forecast.refit_params            # all cities, PM2.5 + AQI
    python3 -m scripts.forecast.refit_params --dry-run
    python3 -m scripts.forecast.refit_params --pollutants pm25

Env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from scripts.forecast.baselines import (  # noqa: E402
    CITIES, SEASON_MONTHS, aqi_series, city_series, climatology, complete_days,
    diurnal_shape, fit_alpha, forecast_mode_table, station_mode_table, load_city_daily,
    load_city_daily_aqi, load_city_hourly, load_history_from_db,
    load_station_daily, load_station_daily_aqi, load_city_hourly_aqi, xkdr_names,
    backtest,
)
from scripts.forecast.station_map import build_monitor_to_xkdr  # noqa: E402
from scripts.ingest.lib.config import TARGET_STATIONS_PATH  # noqa: E402
from scripts.ingest.lib.supabase_client import make_client  # noqa: E402

# Our city names differ from XKDR's. config.py says "Delhi NCR" and
# "Bangalore"; XKDR says "Delhi" and "Bengaluru".
APP_TO_ANALYSIS = {
    "Delhi NCR": "Delhi",
    "Bangalore": "Bengaluru",
    "Mumbai": "Mumbai",
    "Hyderabad": "Hyderabad",
    "Chennai": "Chennai",
    "Kolkata": "Kolkata",
    "Pune": "Pune",
}

# A station with less history than this has no trustworthy seasonal curve. It
# is still fitted and stored -- history_days records the truth -- but serving
# excludes it and falls back to the city.
MIN_HISTORY_DAYS = 365

# The test year the skill numbers are measured against. 2024 is the most recent
# year with a complete pollution season; 2025 stops on 1 September in the XKDR
# export, which would score the forecast on the clean half of the year only.
SKILL_TEST_YEAR = 2024

CLIMATOLOGY_LEN = 367   # index 1..366; element 0 unused so day-of-year indexes directly


def _clim_array(clim: pd.Series) -> List[float]:
    """Day-of-year climatology as a plain list, indexable by day-of-year."""
    arr = [0.0] * CLIMATOLOGY_LEN
    for doy, value in clim.items():
        if 1 <= int(doy) <= 366 and value == value:
            arr[int(doy)] = float(value)
    return arr


def fit_city(analysis_city: str, pollutant: str,
             daily: pd.DataFrame, daily_aqi: pd.DataFrame,
             hourly: pd.DataFrame,
             station_hist: Optional[pd.DataFrame] = None) -> Optional[Dict[str, Any]]:
    """Fit the city-level pieces: alpha, best model, modes, diurnal shape."""
    series = (aqi_series(daily_aqi, analysis_city) if pollutant == "aqi"
              else city_series(daily, analysis_city))
    train = series.dropna()
    if len(train) < MIN_HISTORY_DAYS:
        print(f"  {analysis_city}/{pollutant}: only {len(train)} days of history; skipping")
        return None

    clim = climatology(train)
    alphas = {h: fit_alpha(train, clim, h) for h in (1, 2, 3)}

    # Which model actually wins here, decided by the backtest rather than
    # assumed. This genuinely varies: persistence beats the blend in cities
    # with a shallow seasonal swing, because anchoring on a seasonal average
    # drags the forecast away from the truth. Measured on 2024, persistence
    # wins in Mumbai, Hyderabad and Pune; the blend everywhere else.
    # Measured on stations when we have their history, because the mode is
    # SERVED per station. Falls back to the city series only when there is no
    # station history to measure -- a city-fitted table claims skill at data
    # ages where no individual monitor still has any.
    modes = pd.DataFrame()
    if station_hist is not None and not station_hist.empty:
        modes = station_mode_table(station_hist, analysis_city, SKILL_TEST_YEAR)
    if modes.empty:
        modes = forecast_mode_table(series, SKILL_TEST_YEAR)
    bt = backtest(series, SKILL_TEST_YEAR, [1, 2, 3])
    model = "blend"
    if not bt.empty:
        season = bt[bt.subset == "season"]
        if not season.empty:
            mean_mae = season.groupby("model")["mae"].mean()
            model = str(mean_mae.idxmin())

    shape_rows: List[Dict[str, Any]] = []
    # AQI gets its own shape rather than being skipped. The pollutant driving
    # the max can change with the hour, so AQI's daily profile is not PM2.5's;
    # skipping it left every hourly AQI forecast as the daily number repeated
    # 24 times.
    value_col = "aqi" if pollutant == "aqi" else "pm25"
    if hourly is not None and value_col in hourly.columns:
        g = complete_days(hourly[hourly.city == analysis_city], value_col=value_col)
        if not g.empty:
            shape = diurnal_shape(g, value_col=value_col)
            n_days = g.groupby(["mo", "hr"])["d"].nunique()
            for (month, hour), ratio in shape.items():
                shape_rows.append({
                    "pollutant": pollutant,
                    "month": int(month), "hour": int(hour),
                    "ratio": float(ratio),
                    "n_days": int(n_days.get((month, hour), 0)),
                })

    return {"clim": clim, "alphas": alphas, "model": model,
            "modes": modes, "shape_rows": shape_rows,
            "history_days": len(train)}


def fit_stations(analysis_city: str, pollutant: str, city_fit: Dict[str, Any],
                 station_daily: pd.DataFrame,
                 monitors: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Per-station climatology AND per-station alpha, sharing the city's model.

    Alpha decides how much of today's departure from normal is carried into
    tomorrow. It has to be fitted at the granularity it is SERVED at. A city
    average is much smoother than any single station -- averaging ~70 Delhi
    monitors cancels local noise, and for AQI it also cancels the jitter of the
    max-over-pollutants operator switching between pollutants. Measured lag-3
    anomaly autocorrelation in Delhi: city-mean AQI 0.68, per-station AQI 0.29.

    Fitting on the city and serving per station therefore over-carried each
    station's anomaly by more than double, and the day+1 AQI forecast landed
    WORSE than the seasonal average it started from in Delhi and Bengaluru.
    Stations without enough history of their own still inherit the city alpha,
    which is the best available answer for them.
    """
    rows: List[Dict[str, Any]] = []
    g = station_daily[station_daily.city == analysis_city]

    for mon in monitors:
        # XKDR keys stations by its own ids, so match on name via the manifest.
        sub = g[g.station == mon["xkdr_station"]] if mon.get("xkdr_station") else pd.DataFrame()
        alphas = city_fit["alphas"]
        if sub.empty:
            # No history under this station's XKDR id: fall back to the city
            # curve so the station still forecasts, with history_days = 0
            # marking it for exclusion at serve time.
            clim, hist = city_fit["clim"], 0
        else:
            s = sub.groupby("d")["v"].mean().asfreq("D").dropna()
            if len(s) < 60:
                clim, hist = city_fit["clim"], len(s)
            else:
                clim, hist = climatology(s), len(s)
                if len(s) >= MIN_HISTORY_DAYS:
                    # Enough of its own history to fit its own carry weights.
                    alphas = {h: fit_alpha(s, clim, h) for h in (1, 2, 3)}

        rows.append({
            "monitor_id": mon["monitor_id"],
            "pollutant": pollutant,
            "climatology": _clim_array(clim),
            "alpha_h1": alphas[1],
            "alpha_h2": alphas[2],
            "alpha_h3": alphas[3],
            "model": city_fit["model"],
            "history_days": hist,
            "fitted_at": datetime.now(timezone.utc).isoformat(),
        })
    return rows


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--pollutants", nargs="+", default=["pm25", "aqi"])
    ap.add_argument(
        "--source", choices=("parquet", "db"), default="parquet",
        help="Where history comes from. 'parquet' is the local XKDR export "
             "(full fidelity, including the hourly series behind the diurnal "
             "shape). 'db' reads readings_daily out of Supabase, which is the "
             "only option on a CI runner -- it refits everything except the "
             "diurnal shape, and leaves the existing shape rows untouched.")
    ap.add_argument(
        "--prune-orphans", action="store_true",
        help="Delete forecast_params rows for monitors that are no longer in "
             "the manifest. Off by default: a monitor usually leaves the "
             "manifest because its sensors went stale, and if it comes back "
             "its fitted curve is still there. Orphans are reported either "
             "way, so this is a decision rather than a surprise.")
    args = ap.parse_args()

    print(f"Refit: pollutants={args.pollutants} dry_run={args.dry_run}")

    manifest = json.loads(TARGET_STATIONS_PATH.read_text())

    # Map each of our monitors to the XKDR station_id that holds its history.
    # Without this every station silently falls back to the city curve, which
    # throws away the whole point of fitting per station.
    # Only the parquet path needs this: it keys history by XKDR station id, so
    # each monitor has to be matched to one by name. The DB path is already
    # keyed by monitor_id (see below) and skips the matching entirely.
    monitor_to_xkdr: Dict[str, Optional[str]] = {}
    if args.source == "parquet":
        monitor_to_xkdr = build_monitor_to_xkdr(manifest)
        matched = sum(1 for v in monitor_to_xkdr.values() if v)
        print(f"  station history matched: {matched}/{len(manifest['stations'])}")

    by_city: Dict[str, List[Dict[str, Any]]] = {}
    for st in manifest["stations"]:
        analysis = APP_TO_ANALYSIS.get(st["city"])
        if analysis:
            by_city.setdefault(analysis, []).append(
                {"monitor_id": st["monitor_id"], "name": st["name"],
                 "xkdr_station": monitor_to_xkdr.get(st["monitor_id"])})

    print(f"Loading history from {args.source} ...")
    if args.source == "db":
        hist = load_history_from_db()
        daily, daily_aqi = hist["daily"], hist["daily_aqi"]
        station_daily = hist["station_daily"]
        station_aqi = hist["station_aqi"]
        # readings_daily is daily, so there is no hourly series to refit the
        # diurnal shape from. Passing None makes fit_city skip it rather than
        # overwrite good shape rows with nothing. This applies to AQI too: its
        # shape can only be fitted from the local XKDR parquet.
        hourly = None
        hourly_aqi = None
        # Station history from the DB is keyed by monitor_id -- load_history.py
        # already did the XKDR name matching when it wrote those rows, so the
        # station's own id is the join key here.
        for monitors in by_city.values():
            for mon in monitors:
                mon["xkdr_station"] = mon["monitor_id"]
    else:
        daily = load_city_daily()
        daily_aqi = load_city_daily_aqi()
        hourly = load_city_hourly()
        hourly_aqi = load_city_hourly_aqi()
        station_daily = load_station_daily()
        station_aqi = load_station_daily_aqi()

    params_rows: List[Dict[str, Any]] = []
    shape_rows: List[Dict[str, Any]] = []
    mode_rows: List[Dict[str, Any]] = []

    for analysis_city, monitors in sorted(by_city.items()):
        for pollutant in args.pollutants:
            hourly_for = hourly_aqi if pollutant == "aqi" else hourly
            station_hist = station_aqi if pollutant == "aqi" else station_daily
            fit = fit_city(analysis_city, pollutant, daily, daily_aqi, hourly_for,
                           station_hist=station_hist)
            if fit is None:
                continue
            # The per-station climatology must be fitted on the SAME quantity
            # the forecast serves. AQI is the max of four sub-indices, not a
            # function of PM2.5, so handing station_daily (PM2.5) to an AQI fit
            # silently stores a PM2.5 curve as the station's AQI climatology --
            # which understated Delhi's September AQI by roughly half until
            # 2026-09-22.
            if station_hist is None or station_hist.empty:
                # Fall back to the city curve, but say so. Silent fallback is
                # how the original bug stayed invisible.
                print(f"  {analysis_city}/{pollutant}: no per-station history; "
                      f"every station falls back to the city curve")
                station_hist = pd.DataFrame(columns=["city", "station", "d", "v"])
            params_rows += fit_stations(analysis_city, pollutant, fit,
                                        station_hist, monitors)
            for r in fit["shape_rows"]:
                shape_rows.append({"city": analysis_city, **r})
            for _, m in fit["modes"].iterrows():
                mode_rows.append({
                    "city": analysis_city, "pollutant": pollutant,
                    "data_age_days": int(m.data_age_days),
                    "horizon_days": int(m.horizon_days),
                    "expected_mae": float(m.mae),
                    "climatology_mae": float(m.clim_mae),
                    "skill_pct": float(m.skill_pct),
                    "band_p50": float(m.get("band_p50", np.nan))
                                if m.get("band_p50", np.nan) == m.get("band_p50", np.nan) else None,
                    "band_p80": float(m.get("band_p80", np.nan))
                                if m.get("band_p80", np.nan) == m.get("band_p80", np.nan) else None,
                    "mode": m["mode"],
                    "fitted_at": datetime.now(timezone.utc).isoformat(),
                })
            # Count only the rows this (city, pollutant) just produced --
            # params_rows accumulates across every city, so filtering on
            # pollutant alone counted every earlier city too.
            just_added = params_rows[-len(monitors):] if monitors else []
            thin = sum(1 for r in just_added if r["history_days"] < MIN_HISTORY_DAYS)
            print(f"  {analysis_city:<11} {pollutant:<5} "
                  f"{len(monitors):>3} stations, model={fit['model']}, "
                  f"alpha_h1={fit['alphas'][1]:.2f}, {thin}/{len(monitors)} thin")

    print(f"\nfitted: {len(params_rows)} param rows, {len(shape_rows)} shape rows, "
          f"{len(mode_rows)} mode rows")

    if args.dry_run:
        print("Dry run — nothing written.")
        return

    client = make_client()
    for table, rows, conflict in (
        ("forecast_params", params_rows, "monitor_id,pollutant"),
        ("diurnal_shape", shape_rows, "city,pollutant,month,hour"),
        ("forecast_modes", mode_rows, "city,pollutant,data_age_days,horizon_days"),
    ):
        written = 0
        for i in range(0, len(rows), 250):
            chunk = rows[i:i + 250]
            client.table(table).upsert(chunk, on_conflict=conflict).execute()
            written += len(chunk)
        print(f"  {table}: {written} rows upserted")

    # Monitors drop out of the manifest when their sensors go stale, which
    # leaves their fitted rows behind. Harmless -- nightly_forecast iterates
    # the manifest, not this table -- but worth surfacing so the count does
    # not quietly drift away from the station list.
    live = {st["monitor_id"] for st in manifest["stations"]}
    existing = client.table("forecast_params").select("monitor_id").execute().data or []
    orphans = sorted({r["monitor_id"] for r in existing if r["monitor_id"] not in live})
    if orphans:
        print(f"  forecast_params: {len(orphans)} monitor(s) no longer in the "
              f"manifest still have fitted rows")
        if args.prune_orphans:
            client.table("forecast_params").delete().in_("monitor_id", orphans).execute()
            print(f"    pruned (--prune-orphans)")
        else:
            print(f"    left in place; re-run with --prune-orphans to remove")


if __name__ == "__main__":
    main()
