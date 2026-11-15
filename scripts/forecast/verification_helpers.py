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

def params_as_of(hist: Dict[str, pd.DataFrame], city: str, pollutant: str,
                 test_year: int) -> Dict[str, Dict[str, Any]]:
    """forecast_params rows for one city, fitted only on years before test_year.

    Uses the refit's own fit_city and fit_stations, so each station gets
    exactly the climatology, alphas and history_days the refit would have
    written had it run on 1 January of test_year. (The live app fits on ALL
    history; to score a past season honestly the fit must not see it.)
    Returns monitor_id -> params row.
    """
    train = before_year(hist, test_year)
    fit = rp.fit_city(city, pollutant, train["daily"], train["daily_aqi"],  # ▶ APP CODE: scripts/forecast/refit_params.py · fit_city
                      hourly=None, station_hist=None)
    if fit is None:
        return {}
    rows = rp.fit_stations(city, pollutant, fit,  # ▶ APP CODE: scripts/forecast/refit_params.py · fit_stations
                           station_frame(train, pollutant),
                           monitors_by_city().get(city, []))
    return {r["monitor_id"]: r for r in rows}


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
                    "actual": float(series[t]) if t in series.index else np.nan,
                    "climatology": float(p["climatology"][doy]) or np.nan,
                })
    return pd.DataFrame(out)


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
