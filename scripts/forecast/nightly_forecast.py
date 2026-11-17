"""
Nightly forecast: seven days ahead for every station, written to forecast_daily.

Runs after the daily rollup. Does no fitting -- the monthly refit already
produced the climatology curves, alphas and mode tables, so this job is
lookups and arithmetic and finishes in seconds.

Per station and pollutant:

  1. Find the most recent COMPLETE day in readings_daily (daily_quality.py).
     Its AGE is the pivot of the whole job: OpenAQ's publication lag swings
     between roughly 17 hours and a week, so freshness is a per-station fact,
     not a global one.
  2. Days 1-3: look up forecast_modes for (city, pollutant, age, horizon). That
     row says which model to serve (blend or persistence), how to label it,
     and the band -- all measured together on held-out data by the refit.
     The arithmetic is model.predict; blend's alpha is the one fitted for the
     EFFECTIVE horizon (age + horizon), the same one the skill was measured
     with.
  3. Days 4-7, readings older than 7 days, and any (age, horizon) whose
     measured skill is no better than average: bare climatology, labelled
     seasonal_normal. No band -- these are an average, and drawing uncertainty
     around an average implies a prediction we are not making.
  4. A city-level bias correction, applied only where it has been helping
     (bias_correction.py), and only to rows labelled forecast or outlook.
     Seasonal-normal rows are left as the plain seasonal average their label
     promises (bias_correction.BIAS_CORRECT_MODES). The correction also LEARNS
     only from past +1-day rows with those labels.

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

from scripts.forecast.bias_correction import (  # noqa: E402
    BIAS_CORRECT_MODES,
    apply_corrections,
    apply_offset,
    city_day_errors,
    decide_all,
)
from scripts.forecast.model import (  # noqa: E402
    FORECAST_HORIZONS,
    MAX_SERVED_DATA_AGE,
    alpha_for,
    predict,
)
from scripts.forecast.refit_params import APP_TO_ANALYSIS, MIN_HISTORY_DAYS  # noqa: E402
from scripts.ingest.lib.config import TARGET_STATIONS_PATH, ist_today  # noqa: E402
from scripts.ingest.lib.supabase_client import make_client  # noqa: E402

DEFAULT_HORIZON_DAYS = 7

# How far back to read readings_daily. Longer than MAX_SERVED_DATA_AGE (7):
# the extra week is what tells the completeness rule each station's normal
# day, i.e. whether it reports hourly or every 15 minutes.
LOOKBACK_DAYS = 14


def day_of_year(d: date) -> int:
    return d.timetuple().tm_yday


def load_params(client) -> Dict[Tuple[str, str], Dict[str, Any]]:
    """(monitor_id, pollutant) -> fitted parameters."""
    rows, offset = [], 0
    while True:
        r = (client.table("forecast_params").select("*")
                   .order("monitor_id").order("pollutant")
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
                   .order("city").order("pollutant")
                   .order("data_age_days").order("horizon_days")
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


def fetch_daily_rows(client, since: date) -> List[Dict[str, Any]]:
    """Every readings_daily row since `since`, with what the quality rule needs.

    Ordered, so the 1000-row pages cannot skip or repeat rows: Postgres does
    not promise a stable order between OFFSET queries unless asked for one.
    """
    rows, offset = [], 0
    while True:
        r = (client.table("readings_daily")
                   # is_complete is the rollup's verdict on the day (migration 25).
                   .select("monitor_id, pollutant, date, mean, count, source, is_complete")
                   .in_("pollutant", list(MEASURED_POLLUTANTS))
                   .gte("date", since.isoformat())
                   .order("date").order("monitor_id").order("pollutant")
                   .range(offset, offset + 999).execute())
        rows += r.data or []
        if not r.data or len(r.data) < 1000:
            break
        offset += 1000
    return rows


def observed_values(rows: List[Dict[str, Any]], pollutants: List[str]
                    ) -> Dict[str, Dict[Tuple[str, str], float]]:
    """pollutant -> {(monitor_id, date): value}, complete days only.

    The single place nightly turns readings_daily rows into daily values, so
    the day a forecast starts from and the day it is scored against are built
    the same way. Completeness rules: scripts/forecast/daily_quality.py.
    """
    from scripts.forecast.daily_quality import rows_to_frame, station_day_values

    df = rows_to_frame(rows)
    out: Dict[str, Dict[Tuple[str, str], float]] = {}
    for pollutant in pollutants:
        vals = station_day_values(df, pollutant) if not df.empty else df
        out[pollutant] = {(m, str(d)): float(v) for m, d, v in
                          zip(vals.get("monitor_id", []), vals.get("date", []),
                              vals.get("value", []))}
    return out


def latest_observations(client, pollutants: List[str],
                        since: date) -> Dict[Tuple[str, str], Tuple[date, float]]:
    """(monitor_id, pollutant) -> (date, value) of the most recent COMPLETE day.

    For measured pollutants this is the stored daily mean. For 'aqi' it is
    derived the way CPCB defines NAQI: each pollutant's daily mean becomes its
    sub-index, and the max is taken over the pollutants of that same day.

    Partial days are skipped, so a station whose newest day is only half
    published starts from the day before instead (audit §7.3).
    """
    values = observed_values(fetch_daily_rows(client, since), pollutants)
    latest: Dict[Tuple[str, str], Tuple[date, float]] = {}
    for pollutant, by_day in values.items():
        for (monitor_id, d), v in by_day.items():
            key, day = (monitor_id, pollutant), date.fromisoformat(d)
            if key not in latest or day > latest[key][0]:
                latest[key] = (day, v)
    return latest


def nearest_mode(modes: Dict, city: str, pollutant: str,
                 age: int, horizon: int) -> Optional[Dict[str, Any]]:
    """The mode row measured at this data age, or None if there is none.

    forecast_modes is measured at every age from 0 to MAX_SERVED_DATA_AGE
    (model.MODE_DATA_AGES), so an exact match is expected. Tables fitted before
    Nov 2026 skipped age 6; for those, round UP to the next measured age --
    claiming the skill of a fresher reading than we have would be the wrong way
    to be wrong. Nothing is ever borrowed from a FRESHER age, and an age older
    than anything measured gets None: there is no measured skill to claim.
    """
    exact = modes.get((city, pollutant, age, horizon))
    if exact:
        return exact
    candidates = sorted(a for (c, p, a, h) in modes
                        if c == city and p == pollutant and h == horizon and a >= age)
    return modes.get((city, pollutant, candidates[0], horizon)) if candidates else None


def build_station_rows(monitor_id: str, city: str, pollutant: str,
                       params: Dict[str, Any],
                       observation: Optional[Tuple[date, float]],
                       modes: Dict, today: date,
                       horizon_days: int) -> List[Dict[str, Any]]:
    """Seven rows for one station-pollutant.

    For days 1-3 the mode row for this (city, pollutant, data age, horizon)
    decides everything shown: which model makes the number, how it is
    labelled, and the band around it -- all measured together by the refit, so
    the label always describes the number it is attached to.
    """
    clim = params["climatology"]

    def clim_for(d: date) -> Optional[float]:
        doy = day_of_year(d)
        v = clim[doy] if doy < len(clim) else 0.0
        return float(v) if v else None

    obs_value, obs_base, based_on, age = None, None, None, None
    if observation is not None:
        obs_date, obs_value = observation
        age = (today - obs_date).days
        obs_base = clim_for(obs_date)
        # Older than the stalest age the mode table measured: no skill to
        # claim, so this station gets the seasonal normal.
        if obs_base is not None and 0 <= age <= MAX_SERVED_DATA_AGE:
            based_on = obs_date
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

        value, mode, band50, band80 = base, "seasonal_normal", None, None
        model = "climatology"
        if not degraded and h in FORECAST_HORIZONS:
            m = nearest_mode(modes, city, pollutant, age, h)
            # Rows fitted before Nov 2026 carry no model: they measured the blend.
            served = (m.get("model") or "blend") if m else None
            # An observation `age` days old forecasting `h` days out is really
            # an (age + h)-step problem, and alpha was fitted for exactly that.
            alpha = alpha_for(params, age + h)
            usable = (m is not None and m["mode"] != "seasonal_normal"
                      and (served == "persistence" or alpha is not None))
            # Otherwise (mode says seasonal_normal, no measured mode at all, or
            # no alpha fitted for this effective horizon) the seasonal average
            # is served, and labelled as exactly that. Carrying the anomaly
            # forward under a "seasonal_normal" label would put a number on
            # screen that contradicts its own label.
            if usable:
                value = max(float(predict(served, base, obs_value, obs_base, alpha)),
                            0.0)  # a negative forecast is not one
                mode, model = m["mode"], served
                band50, band80 = m.get("band_p50"), m.get("band_p80")

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
                        ) -> Tuple[List[Dict[str, Any]], Dict[Tuple[str, str, str], float]]:
    """Past forecasts and what actually happened, for learning the bias.

    Returns the forecasts (carrying value_raw where one was stored, and the
    `mode` label each was served with) and the observed daily value per
    (monitor_id, date, pollutant) -- the same key the forecasts carry, so
    city_day_errors can line them up.

    Every label is returned, not only forecast/outlook: city_day_errors does
    the filtering (BIAS_CORRECT_MODES), so the notebook can still score the
    seasonal-normal rows from the same fetch. forecast_daily.mode is NOT NULL
    (database-setup/12-forecast-tables.sql), so every row carries one. The +1
    row for a target date is the one written the night before it, so its mode
    is the label that night's forecast was served with.

    The pollutant MUST be part of the key. Until Nov 2026 it was keyed by
    (monitor_id, date) alone, so the AQI written second overwrote the PM2.5
    value and every PM2.5 forecast was scored against composite AQI. AQI is
    almost always the larger number, so the correction "learned" that PM2.5
    was under-forecast and pushed it up towards the +50% cap.
    """
    fc, offset = [], 0
    while True:
        r = (client.table("forecast_daily")
                   .select("monitor_id, pollutant, target_date, value, value_raw, mode")
                   .eq("horizon_days", 1)
                   .in_("pollutant", pollutants)
                   .gte("target_date", since.isoformat())
                   .order("target_date").order("monitor_id").order("pollutant")
                   .range(offset, offset + 999).execute())
        fc += r.data or []
        if not r.data or len(r.data) < 1000:
            break
        offset += 1000

    # Same construction as latest_observations, complete days only. Deriving
    # it differently here would make the measured bias an artefact of the two
    # definitions disagreeing -- and scoring against a half-published day
    # would teach the correction a bias that is not there.
    values = observed_values(fetch_daily_rows(client, since), pollutants)
    actuals: Dict[Tuple[str, str, str], float] = {
        (mid, d, pollutant): v
        for pollutant, by_day in values.items()
        for (mid, d), v in by_day.items()
    }
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
        client, args.pollutants, today - timedelta(days=LOOKBACK_DAYS))
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
    # Learned only from rows labelled forecast/outlook (BIAS_CORRECT_MODES):
    # the same rows it is allowed to correct. Every city/pollutant in the
    # manifest gets a decision, so one with no such rows is logged -- and its
    # forecast_bias row overwritten -- as "skip" with the reason, instead of
    # silently keeping last night's decision.
    errors = city_day_errors(hist_fc, hist_actual, city_of)
    learnable = sum(1 for f in hist_fc if f.get("mode") in BIAS_CORRECT_MODES)
    keys = sorted({(c, p) for c in set(city_of.values()) for p in args.pollutants})
    decisions = decide_all(errors, keys, today, BIAS_HISTORY_DAYS)

    print(f"\n  bias correction, from {len(hist_fc)} scored forecasts "
          f"({learnable} labelled {'/'.join(BIAS_CORRECT_MODES)}, the only ones learned from):")
    for (city, pollutant), d in sorted(decisions.items()):
        mark = "APPLY " if d["applied"] else "skip  "
        print(f"    {mark}{city:<12}{pollutant:<6}offset {d['offset']:+8.2f}   {d['reason']}")
    # Only rows labelled forecast/outlook are corrected; seasonal-normal rows
    # stay the plain seasonal average their label promises (BIAS_CORRECT_MODES).
    counts = apply_corrections(out_rows, decisions)
    print(f"    corrected {counts['corrected']} of {len(out_rows)} rows "
          f"(left alone: {counts['city_not_applied']} in cities not corrected tonight, "
          f"{counts['mode_excluded']} labelled outside {'/'.join(BIAS_CORRECT_MODES)})")

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

    # Monitors that have left the manifest (sensors gone stale) keep the
    # future rows of their last run, and the app would go on serving them as
    # if current (audit §7.8). Delete only rows for today onwards: past rows
    # stay, because the bias correction scores them.
    live = {s["monitor_id"] for s in manifest["stations"]}
    orphans = departed_monitors(client, live, today)
    for i in range(0, len(orphans), 100):
        (client.table("forecast_daily").delete()
               .in_("monitor_id", orphans[i:i + 100])
               .gte("target_date", today.isoformat()).execute())
    print(f"  forecast_daily: future rows removed for {len(orphans)} monitor(s) "
          f"no longer in the station list")


def departed_monitors(client, live: set, today: date) -> List[str]:
    """Monitors with forecast rows from today on that are not in the manifest."""
    seen, offset = set(), 0
    while True:
        r = (client.table("forecast_daily").select("monitor_id")
                   .gte("target_date", today.isoformat())
                   .order("monitor_id").order("pollutant").order("target_date")
                   .range(offset, offset + 999).execute())
        seen |= {row["monitor_id"] for row in (r.data or [])}
        if not r.data or len(r.data) < 1000:
            break
        offset += 1000
    return sorted(seen - live)


if __name__ == "__main__":
    main()
