"""
Rebuild the simulation test's expected output from its frozen inputs.

Run this ONLY after a deliberate change to the forecast logic has made
tests/test_forecast_simulation.py fail, and you have checked that the change in
numbers is the one you intended. Then read the diff of golden_city_hourly.csv
before committing it.

Reads and writes only tests/fixtures/simulation/. Never touches Supabase. The
frozen inputs (observations, forecast_params, forecast_modes, diurnal_shape,
monitors) are left exactly as they are -- only the outputs computed from them
are rewritten:

    golden_city_hourly.csv     per-city hourly aggregates + per-station checksum
    climatology_baseline.csv   skill against climatology, per city
    meta.json                  "regenerated_at" and "regeneration_log" appended

Formerly a cell in notebooks/forecast_simulation.ipynb (retired Nov 2026).

Usage (from repo root):
    /usr/bin/python3 -m scripts.forecast.regenerate_simulation_golden "why the numbers changed"
"""

from __future__ import annotations

import json
import sys
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO))

from scripts.forecast import simulate as sim  # noqa: E402

FIX = REPO / "tests" / "fixtures" / "simulation"
KEY = ["branch", "pollutant", "city", "target_date", "hour"]


def main() -> None:
    if len(sys.argv) < 2 or not sys.argv[1].strip():
        raise SystemExit("Give a one-line reason, e.g. "
                         '"completeness rule for the starting day".')
    reason = sys.argv[1].strip()

    meta = json.loads((FIX / "meta.json").read_text())
    data = {name: pd.read_parquet(FIX / f"{name}.parquet")
            for name in ["forecast_params", "diurnal_shape", "forecast_modes", "monitors"]}
    obs = pd.read_parquet(FIX / "observations.parquet")
    run_dates = [date.fromisoformat(d) for d in meta["run_dates"]]

    result = sim.run_simulation(obs, data, run_dates,
                                pollutants=tuple(meta["pollutants"]),
                                branches=tuple(meta["branches"]),
                                horizon=meta["horizon_days"], verbose=False)
    scored = sim.score_by_city_hour(result)

    # Per-station checksum: catches a station-level change that averages out
    # at city level. Same construction as the original notebook cell.
    checksum = (result.groupby(KEY)
                      .apply(lambda g: float(np.round(np.sum(
                          g["predicted"].values * (np.arange(len(g)) + 1)), 4)),
                             include_groups=False)
                      .rename("station_checksum").reset_index())

    golden = scored.merge(checksum, on=KEY).sort_values(KEY)
    for col in ["mae", "bias", "rmse", "predicted", "actual"]:
        golden[col] = golden[col].round(4)
    golden.to_csv(FIX / "golden_city_hourly.csv", index=False)
    sim.climatology_baseline(result).to_csv(FIX / "climatology_baseline.csv", index=False)

    meta["regenerated_at"] = pd.Timestamp.utcnow().isoformat()
    meta.setdefault("regeneration_log", []).append(
        {"at": meta["regenerated_at"], "reason": reason})
    meta["note"] = ("Regenerate with scripts/forecast/regenerate_simulation_golden.py. "
                    "Golden values encode CURRENT forecast behaviour, bugs included; "
                    "a deliberate improvement is expected to change them.")
    (FIX / "meta.json").write_text(json.dumps(meta, indent=2))
    print(f"golden_city_hourly.csv: {len(golden):,} rows; reason logged: {reason}")


if __name__ == "__main__":
    main()
