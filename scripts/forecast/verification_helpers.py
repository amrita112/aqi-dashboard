"""
Plumbing for notebooks/forecast_verification.ipynb.

Nothing in here is forecasting logic. Every number the notebook shows is made
by the app's own functions (scripts/forecast/*.py); this file only does the
fetching, caching and looping around them, so the notebook cells stay short
enough to read. Where a helper calls app code, the line is marked
"# ▶ APP CODE", the same way the notebook marks it.

READ ONLY. The Supabase client handed out here refuses every write (insert,
upsert, update, delete, rpc, Storage upload). The notebook must never change
what the app serves.
"""

from __future__ import annotations

import json
import os
import sys
from datetime import date, timedelta
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

import numpy as np
import pandas as pd

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO))

from scripts.forecast import nightly_forecast as nf  # noqa: E402
from scripts.forecast import refit_params as rp  # noqa: E402
from scripts.forecast.baselines import (  # noqa: E402
    APP_TO_ANALYSIS_CITY, SEASON_MONTHS, load_history_from_db,
)
from scripts.ingest.lib.config import TARGET_STATIONS_PATH  # noqa: E402

CACHE_DIR = REPO / "data" / "notebook-cache"

# Local copies of the two history files the refit reads from Supabase Storage.
# load_history_from_db reads these instead of downloading when the env vars
# point at them (baselines.HISTORY_FILES).
LOCAL_HISTORY_FILES = {
    "XKDR_HISTORY_FILE": REPO / "data" / "xkdr_daily_history.parquet",
    "ARCHIVE_HISTORY_FILE": REPO / "data" / "openaq_archive_daily_history.parquet",
}


# ─── A Supabase client that cannot write ─────────────────────────────────────

class _ReadOnlyTable:
    """Wraps one table query builder. Reads pass through; writes raise."""

    WRITES = {"insert", "upsert", "update", "delete"}

    def __init__(self, builder, name: str, drop_columns: Iterable[str]):
        self._builder, self._name = builder, name
        self._drop = set(drop_columns)

    def select(self, columns: str = "*", **kwargs):
        # Columns the app's code asks for but this database does not have yet
        # (readings_daily.is_complete before migration 25) are left out of the
        # request. The code then computes the flag itself, from the same rule.
        if self._drop:
            kept = [c.strip() for c in columns.split(",") if c.strip() not in self._drop]
            columns = ", ".join(kept)
        return self._builder.select(columns, **kwargs)

    def __getattr__(self, attr):
        if attr in self.WRITES:
            raise PermissionError(
                f"verification notebook is read-only: refused {self._name}.{attr}()")
        return getattr(self._builder, attr)


class _ReadOnlyBucket:
    def __init__(self, bucket):
        self._bucket = bucket

    def download(self, *args, **kwargs):
        return self._bucket.download(*args, **kwargs)

    def list(self, *args, **kwargs):
        return self._bucket.list(*args, **kwargs)

    def __getattr__(self, attr):
        raise PermissionError(f"verification notebook is read-only: refused storage.{attr}()")


class _ReadOnlyStorage:
    def __init__(self, storage):
        self._storage = storage

    def from_(self, bucket: str):
        return _ReadOnlyBucket(self._storage.from_(bucket))


class ReadOnlyClient:
    """The service-role Supabase client, with every write path blocked.

    `missing_columns` maps table -> columns that do not exist in this database
    yet; see _ReadOnlyTable.select.
    """

    def __init__(self, client, missing_columns: Dict[str, List[str]]):
        self._client = client
        self.missing_columns = missing_columns

    def table(self, name: str):
        return _ReadOnlyTable(self._client.table(name), name,
                              self.missing_columns.get(name, []))

    from_ = table

    @property
    def storage(self):
        return _ReadOnlyStorage(self._client.storage)

    def rpc(self, *args, **kwargs):
        raise PermissionError("verification notebook is read-only: refused rpc()")


def read_only_client() -> ReadOnlyClient:
    """Connect with the credentials in .env.local, read-only.

    Also checks whether migration 25 (readings_daily.is_complete) has been
    run, because the app's loaders ask for that column.
    """
    from dotenv import load_dotenv
    from scripts.ingest.lib.supabase_client import make_client

    load_dotenv(REPO / ".env.local")
    raw = make_client()
    missing: Dict[str, List[str]] = {}
    try:
        raw.table("readings_daily").select("is_complete").limit(1).execute()
    except Exception:
        missing["readings_daily"] = ["is_complete"]
    return ReadOnlyClient(raw, missing)


# ─── The station list ────────────────────────────────────────────────────────

def manifest_stations() -> List[Dict[str, Any]]:
    """scripts/ingest/target_stations.json, each station with its analysis city."""
    stations = json.loads(TARGET_STATIONS_PATH.read_text())["stations"]
    for s in stations:
        s["analysis_city"] = rp.APP_TO_ANALYSIS.get(s["city"], s["city"])
    return stations


def monitors_by_city() -> Dict[str, List[Dict[str, Any]]]:
    """analysis city -> monitors, shaped the way refit_params.main builds them
    for the DB path (history keyed by monitor_id, so xkdr_station = monitor_id).
    """
    out: Dict[str, List[Dict[str, Any]]] = {}
    for s in manifest_stations():
        out.setdefault(s["analysis_city"], []).append(
            {"monitor_id": s["monitor_id"], "name": s["name"],
             "xkdr_station": s["monitor_id"]})
    return out


def city_of_monitor() -> Dict[str, str]:
    """monitor_id -> analysis city, as nightly_forecast.main builds it."""
    return {s["monitor_id"]: s["analysis_city"] for s in manifest_stations()}


# ─── History, exactly as the monthly refit loads it ──────────────────────────

HISTORY_FRAMES = ("daily", "daily_aqi", "station_daily", "station_aqi")


def load_history(client, refresh: bool = False, today: Optional[date] = None
                 ) -> Dict[str, pd.DataFrame]:
    """baselines.load_history_from_db -- the refit's own loader -- cached for a day.

    The loader reads the two Storage history files (from the local copies in
    data/, via the env vars it already supports) plus our own days from
    readings_daily, applies the completeness rule, and builds the city and
    station series the refit fits on. That takes a few minutes, mostly paging
    readings_daily, so the result is saved under data/notebook-cache/ and
    reused for the rest of the IST day.
    """
    from scripts.ingest.lib.config import ist_today

    today = today or ist_today()
    folder = CACHE_DIR / f"history-{today.isoformat()}"
    if not refresh and all((folder / f"{n}.parquet").exists() for n in HISTORY_FRAMES):
        print(f"Using today's cached history: {folder.relative_to(REPO)}")
        return {n: pd.read_parquet(folder / f"{n}.parquet") for n in HISTORY_FRAMES}

    for env, path in LOCAL_HISTORY_FILES.items():
        if path.exists():
            os.environ[env] = str(path)
        else:
            print(f"  {path.name} not found locally; the loader will download it")
    hist = load_history_from_db(client, until=str(today))  # ▶ APP CODE: scripts/forecast/baselines.py · load_history_from_db
    folder.mkdir(parents=True, exist_ok=True)
    for n in HISTORY_FRAMES:
        hist[n].to_parquet(folder / f"{n}.parquet", index=False)
    print(f"Saved to {folder.relative_to(REPO)}")
    return hist


def station_frame(hist: Dict[str, pd.DataFrame], pollutant: str) -> pd.DataFrame:
    """The per-station daily table the refit fits `pollutant` on (city, station, d, v)."""
    return hist["station_aqi"] if pollutant == "aqi" else hist["station_daily"]


def before_year(hist: Dict[str, pd.DataFrame], year: int) -> Dict[str, pd.DataFrame]:
    """The same history, cut off at 1 January of `year`."""
    cut = pd.Timestamp(f"{year}-01-01")
    return {n: f[f["d"] < cut] for n, f in hist.items()}


# ─── Parameters as the refit would have fitted them on an earlier date ──────

def fit_as_of(hist: Dict[str, pd.DataFrame], city: str, pollutant: str,
              test_year: Optional[int] = None
              ) -> Tuple[Optional[Dict[str, Any]], Dict[str, Dict[str, Any]]]:
    """The refit's city fit and station rows, fitted on years before test_year.

    test_year=None fits on ALL history -- exactly what the live monthly refit
    (refit_params.py) stores and the app serves. A year fits only on the years
    before it, which is what the notebook scores, so a held-out season is never
    in its own training data. Returns (city_fit, monitor_id -> params row);
    city_fit is None when the city has too little history.
    """
    train = hist if test_year is None else before_year(hist, test_year)
    fit = rp.fit_city(city, pollutant, train["daily"], train["daily_aqi"],  # ▶ APP CODE: scripts/forecast/refit_params.py · fit_city
                      hourly=None, station_hist=None)
    if fit is None:
        return None, {}
    rows = rp.fit_stations(city, pollutant, fit,  # ▶ APP CODE: scripts/forecast/refit_params.py · fit_stations
                           station_frame(train, pollutant),
                           monitors_by_city().get(city, []))
    return fit, {r["monitor_id"]: r for r in rows}


def params_as_of(hist: Dict[str, pd.DataFrame], city: str, pollutant: str,
                 test_year: Optional[int]) -> Dict[str, Dict[str, Any]]:
    """forecast_params rows for one city, fitted only on years before test_year.

    Uses the refit's own fit_city and fit_stations, so each station gets
    exactly the climatology, alphas and history_days the refit would have
    written had it run on 1 January of test_year. (The live app fits on ALL
    history; to score a past season honestly the fit must not see it.
    test_year=None gives that all-history fit.) Returns monitor_id -> params row.
    """
    return fit_as_of(hist, city, pollutant, test_year)[1]


def modes_index(mode_table: pd.DataFrame, city: str, pollutant: str) -> Dict:
    """A station_mode_table, keyed the way nightly_forecast.load_modes keys
    forecast_modes: (city, pollutant, data_age, horizon) -> row."""
    from scripts.forecast.simulate import index_modes
    t = mode_table.assign(city=city, pollutant=pollutant)
    return index_modes(t)  # ▶ APP CODE: scripts/forecast/simulate.py · index_modes


# ─── Replaying a past season through the serving function ────────────────────

def season_dates(year: int) -> List[pd.Timestamp]:
    """The held-out pollution season the app's skill is measured on: the
    SEASON_MONTHS (Oct-Jan) days of `year` -- January and Oct-Dec of that year."""
    days = pd.date_range(f"{year}-01-01", f"{year}-12-31", freq="D")
    return [d for d in days if d.month in SEASON_MONTHS]


def replay_served(stations: pd.DataFrame, city: str, pollutant: str,
                  params: Dict[str, Dict[str, Any]], modes: Dict,
                  targets: Iterable[pd.Timestamp], data_age: int,
                  horizons: Tuple[int, ...] = (1, 2, 3)) -> pd.DataFrame:
    """What the app would have served for each target day, and what happened.

    For every station with params, and every target day T and horizon h, the
    forecast is made on the night of T - h by nightly_forecast.build_station_rows
    -- the serving function itself -- from the station's reading exactly
    `data_age` days before that night. Days where that reading is missing are
    skipped rather than filled from an older one (the app would use an older
    reading, i.e. a larger data age), so each row is scored at the age it says.

    Returns one row per (station, target, horizon): served value, mode, model,
    the actual complete-day value at the station, and the station's
    climatology for that day (the seasonal normal it is judged against).
    """
    targets = sorted(set(pd.Timestamp(t) for t in targets))
    target_set = set(targets)
    frame = stations[stations.city == city]
    out: List[Dict[str, Any]] = []
    for station, sub in frame.groupby("station"):
        p = params.get(station)
        if p is None:
            continue
        series = sub.groupby("d")["v"].mean()
        nights = sorted({t - pd.Timedelta(days=h) for t in targets for h in horizons})
        for night in nights:
            obs_day = night - pd.Timedelta(days=data_age)
            if obs_day not in series.index:
                continue
            obs = (obs_day.date(), float(series[obs_day]))
            rows = nf.build_station_rows(station, city, pollutant, p, obs,  # ▶ APP CODE: scripts/forecast/nightly_forecast.py · build_station_rows
                                         modes, night.date(), max(horizons))
            for r in rows:
                t = pd.Timestamp(r["target_date"])
                if r["horizon_days"] not in horizons or t not in target_set:
                    continue
                doy = t.dayofyear
                out.append({
                    "station": station, "target": t, "horizon": r["horizon_days"],
                    "served": r["value"], "mode": r["mode"], "model": r["model"],
                    "data_age": r["data_age_days"],
                    # The band ratio the app would show around this number
                    # (None for seasonal_normal rows, which carry no band).
                    "band_p80": r["band_p80"],
                    "actual": float(series[t]) if t in series.index else np.nan,
                    "climatology": float(p["climatology"][doy]) or np.nan,
                })
    return pd.DataFrame(out)


# ─── The bias correction, replayed night by night ────────────────────────────

def bias_warmup_dates(targets: Iterable[pd.Timestamp], history_days: int,
                      max_horizon: int) -> List[pd.Timestamp]:
    """Days just BEFORE each stretch of held-out days, needed only as history.

    Nightly learns its bias from the +1-day forecasts of the previous
    `history_days` days. On 1 October that history is late September, which is
    not a held-out day, so the replay also forecasts those days (at +1 only) to
    give the correction the same history it would have had live. Returns the
    days within history_days + max_horizon before some target that are not
    themselves targets.
    """
    targets = set(pd.Timestamp(t) for t in targets)
    reach = history_days + max_horizon
    warm = {t - pd.Timedelta(days=k) for t in targets for k in range(1, reach + 1)}
    return sorted(warm - targets)


def replay_bias_correction(replay: pd.DataFrame, warmup: pd.DataFrame,
                           city: str, pollutant: str, data_age: int,
                           history_days: Optional[int] = None
                           ) -> Tuple[pd.DataFrame, pd.DataFrame]:
    """Apply nightly's bias correction to a replay, using only what was known.

    `replay` is replay_served's output for the held-out days; `warmup` is the
    same for bias_warmup_dates (horizon 1 only). For every replayed night N
    this does what nightly_forecast.main does on night N, with the app's own
    functions:

      1. the stored +1-day forecasts of the last `history_days` days are the
         history (load_scored_history's window);
      2. bias_correction.city_day_errors turns them into one mean error per
         target day for the city, learning only from forecast/outlook rows;
      3. bias_correction.decide_all decides apply/skip and the offset;
      4. bias_correction.apply_corrections corrects that night's rows.

    NO LOOK-AHEAD. On night N only errors for target days up to N - data_age
    are used: a reading `data_age` days old means nothing newer had been
    published, so neither had any newer actual value. (decide itself already
    ignores day N and later.)

    Returns (replay with `served_bc` -- the number the app would have shown --
    and `bias_applied`, one row per night with the decision taken).
    """
    from scripts.forecast import bias_correction as bc

    history_days = history_days or nf.BIAS_HISTORY_DAYS
    out = replay.copy()
    out["served_bc"] = out["served"]
    out["bias_applied"] = False
    if out.empty:
        return out, pd.DataFrame()

    # The +1-day rows nightly would have stored (value_raw = None: in the
    # replay every stored number is the uncorrected model output, which is
    # what city_day_errors learns from anyway).
    plus1 = pd.concat([warmup, replay[replay.horizon == 1]], ignore_index=True)
    plus1 = plus1.drop_duplicates(["station", "target"])
    forecasts = [{"monitor_id": r.station, "pollutant": pollutant,
                  "target_date": r.target.date().isoformat(), "value": r.served,
                  "value_raw": None, "mode": r.mode}
                 for r in plus1.itertuples()]
    actuals = {(r.station, r.target.date().isoformat(), pollutant): float(r.actual)
               for r in plus1.itertuples() if pd.notna(r.actual)}
    city_of = {s: city for s in plus1.station.unique()}
    # One mean error per target day. Each day's mean uses only that day's
    # rows, so computing it once and then cutting the window per night gives
    # the same numbers as recomputing it every night.
    all_errors = bc.city_day_errors(forecasts, actuals, city_of).get(  # ▶ APP CODE: scripts/forecast/bias_correction.py · city_day_errors
        (city, pollutant), {})

    out["night"] = out.target - pd.to_timedelta(out.horizon, unit="D")
    log = []
    for night, idx in out.groupby("night").groups.items():
        n = night.date()
        first = n - timedelta(days=history_days)
        known_until = n - timedelta(days=data_age)
        known = {d: e for d, e in all_errors.items() if first <= d <= known_until}
        decisions = bc.decide_all({(city, pollutant): known} if known else {},  # ▶ APP CODE: scripts/forecast/bias_correction.py · decide_all
                                  [(city, pollutant)], n, history_days)
        rows = [{"city_key": city, "pollutant": pollutant,
                 "mode": out.at[i, "mode"], "value": out.at[i, "served"]} for i in idx]
        bc.apply_corrections(rows, decisions)  # ▶ APP CODE: scripts/forecast/bias_correction.py · apply_corrections
        for i, r in zip(idx, rows):
            out.at[i, "served_bc"] = r["value"]
            out.at[i, "bias_applied"] = r["value_raw"] is not None
        d = decisions[(city, pollutant)]
        log.append({"night": night, "applied": d["applied"], "offset": d["offset"],
                    "n_days": d["n_days"], "reason": d["reason"]})
    return out.drop(columns="night"), pd.DataFrame(log)


# ─── The band the app shows, around the number it shows ──────────────────────

def served_band(replay: pd.DataFrame, city: str, pollutant: str,
                value_col: str = "served_bc") -> pd.DataFrame:
    """band_low / band_high exactly as the app computes them for each row.

    Runs every replayed row through serving_mirror.expand_day, the Python copy
    of lib/api/forecast.ts expandDay (value x (1 -/+ band_p80), rounded the
    same way), pinned to the TypeScript by tests/test_serving_mirror.py.
    `value_col` picks which number the band is drawn around: "served_bc" is
    what the app shows; "served" is the model output before bias correction.
    """
    from scripts.forecast import serving_mirror as mirror

    lows, highs = [], []
    for r in replay.itertuples():
        b = r.band_p80
        row = {"pollutant": pollutant, "target_date": r.target.date().isoformat(),
               "horizon_days": int(r.horizon), "value": getattr(r, value_col),
               # NaN (no band measured) behaves like the app's null.
               "band_p80": None if b is None or pd.isna(b) else float(b),
               "mode": r.mode, "model": r.model, "based_on_date": None,
               "data_age_days": r.data_age}
        night = (r.target - pd.Timedelta(days=int(r.horizon))).date().isoformat()
        day = mirror.expand_day(row, city, {}, night, hourly=False)  # ▶ APP CODE (mirror of lib/api/forecast.ts): expandDay
        lows.append(day["band_low"])
        highs.append(day["band_high"])
    return pd.DataFrame({"band_low": lows, "band_high": highs}, index=replay.index)


# ─── The fit the app serves vs the fit the notebook scores ───────────────────

def fit_difference(served: Dict[str, Dict[str, Any]], scored: Dict[str, Dict[str, Any]],
                   season_only: bool = True) -> pd.DataFrame:
    """Per station: how far the all-history fit is from the pre-test-year fit.

    `served` and `scored` are monitor_id -> params rows (fit_as_of with
    test_year=None and with the test year). Plain subtraction, no model:
    for each station both fits cover, it reports
      own_fit_*      whether each fit had enough of the station's own history
                     for its own alphas (refit_params.MIN_HISTORY_DAYS); a
                     station without it inherits the city alpha, and with
                     under 60 days the city climatology too;
      alpha_diff_h<k>  served alpha minus scored alpha, per effective horizon k;
      clim_mae, clim_pct  mean |served - scored| climatology, in the
                     pollutant's unit and as % of the served curve, over the
                     pollution season (SEASON_MONTHS) or the whole year.
    """
    if season_only:
        doys = sorted({d.dayofyear for d in pd.date_range("2024-01-01", "2024-12-31")
                       if d.month in SEASON_MONTHS})
    else:
        doys = list(range(1, 367))
    rows = []
    for mid in sorted(set(served) & set(scored)):
        a, b = served[mid], scored[mid]
        ca = np.array([a["climatology"][d] for d in doys], dtype=float)
        cb = np.array([b["climatology"][d] for d in doys], dtype=float)
        ok = (ca > 0) & (cb > 0)          # 0 marks a day-of-year with no value
        row = {"station": mid,
               "own_fit_served": a["history_days"] >= rp.MIN_HISTORY_DAYS,
               "own_fit_scored": b["history_days"] >= rp.MIN_HISTORY_DAYS,
               "history_days_served": a["history_days"],
               "history_days_scored": b["history_days"],
               "clim_mae": float(np.abs(ca[ok] - cb[ok]).mean()) if ok.any() else np.nan,
               "clim_pct": float(100 * (np.abs(ca[ok] - cb[ok]) / ca[ok]).mean()) if ok.any() else np.nan}
        for k in range(1, min(len(a["alphas"]), len(b["alphas"]))):
            row[f"alpha_diff_h{k}"] = float(a["alphas"][k]) - float(b["alphas"][k])
        rows.append(row)
    return pd.DataFrame(rows)


def skill_from_replay(replay: pd.DataFrame, stations: pd.DataFrame, city: str,
                      params: Dict[str, Dict[str, Any]],
                      targets: Iterable[pd.Timestamp]) -> pd.DataFrame:
    """Per-station skill of the SERVED numbers, scored the way the refit scores.

    model_skill_table scores the forecast on the days that have one, and the
    climatology on every held-out day with an actual value. This does the same
    so the two can be compared number for number.
    """
    targets = set(pd.Timestamp(t) for t in targets)
    frame = stations[stations.city == city]
    rows = []
    for station, sub in frame.groupby("station"):
        p = params.get(station)
        if p is None:
            continue
        s = sub.groupby("d")["v"].mean()
        s = s[s.index.isin(targets)]
        clim = np.array([p["climatology"][d.dayofyear] for d in s.index])
        clim_mae = float(np.abs(clim - s.values).mean()) if len(s) else np.nan
        mine = replay[(replay.station == station) & replay.actual.notna()]
        for h, g in mine.groupby("horizon"):
            mae = float(np.abs(g.served - g.actual).mean())
            rows.append({"station": station, "horizon": h, "mae": mae,
                         "clim_mae": clim_mae, "n": len(g),
                         "skill_pct": 100 * (clim_mae - mae) / clim_mae,
                         "mode": g["mode"].mode().iat[0]})
    return pd.DataFrame(rows)


# ─── Reading what the app served ─────────────────────────────────────────────

def fetch_all(client, table: str, columns: str = "*", filters=(),
              order: Tuple[str, ...] = ()) -> pd.DataFrame:
    """Page a (small) table out of Supabase, 1000 rows at a time, in a stable order."""
    rows, offset = [], 0
    while True:
        q = client.table(table).select(columns)
        for method, *args in filters:
            q = getattr(q, method)(*args)
        for col in order:
            q = q.order(col)
        batch = q.range(offset, offset + 999).execute().data or []
        rows += batch
        if len(batch) < 1000:
            break
        offset += 1000
    return pd.DataFrame(rows)


def which_code_wrote(params: Dict, modes: Dict) -> Dict[str, Any]:
    """Was the stored forecast made by the post-audit code (Nov 2026) or the old one?

    Only the new refit fills forecast_params.alphas (one alpha per effective
    horizon) and forecast_modes.model (the model chosen per data age). If those
    are empty, the refit -- and so the nightly forecasts built on it -- are
    still the pre-audit version.
    """
    n_alpha = sum(1 for r in params.values() if r.get("alphas") is not None)
    n_model = sum(1 for r in modes.values() if r.get("model") is not None)
    new = n_alpha > 0 and n_model > 0
    return {"params_with_alphas": n_alpha, "params_total": len(params),
            "modes_with_model": n_model, "modes_total": len(modes),
            "new_code": new}


@lru_cache(maxsize=1)
def _station_names() -> Dict[str, str]:
    return {s["monitor_id"]: s["name"] for s in manifest_stations()}


def manifest_name(monitor_id: str) -> str:
    """A station's human-readable name from the manifest (or its id if unknown)."""
    return _station_names().get(monitor_id, monitor_id)
