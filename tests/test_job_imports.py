"""Every scheduled job must at least import.

WHY THIS EXISTS. The nightly forecast failed for three days running with
`NameError: name 'city_day_errors' is not defined` — an import that was never
added, because the edit targeted a line that did not exist in that file and
failed silently. Nothing caught it: the unit tests exercise the bias-correction
functions directly and never load the job that calls them, and the job only
runs in GitHub Actions at 05:30 UTC.

Importing a module runs its top-level code, which is where missing imports,
syntax errors and bad module paths live. It is a cheap test that would have
turned three days of stale forecasts into a red tick before the push.
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# Every module with an entry point that runs on a schedule or by hand.
JOBS = [
    "scripts.forecast.nightly_forecast",
    "scripts.forecast.bias_correction",
    "scripts.forecast.refit_params",
    "scripts.ingest.ingest_recent_readings",
    "scripts.ingest.daily_backfill_s3",
    "scripts.ingest.rollup_daily",
]


@pytest.mark.parametrize("module", JOBS)
def test_job_module_imports(module: str) -> None:
    importlib.import_module(module)


@pytest.mark.parametrize("module", JOBS)
def test_job_has_an_entry_point(module: str) -> None:
    """A scheduled job with no main() is a script nothing can run."""
    assert hasattr(importlib.import_module(module), "main") or module.endswith(
        "bias_correction"
    ), f"{module} has no main()"


def test_nightly_forecast_can_see_its_bias_helpers() -> None:
    """The exact failure, named.

    These three come from bias_correction and are called inside main(), so a
    missing import is invisible until the job runs against a real database.
    """
    m = importlib.import_module("scripts.forecast.nightly_forecast")
    for fn in ("city_day_errors", "decide", "apply_offset", "load_scored_history"):
        assert hasattr(m, fn), f"nightly_forecast cannot see {fn}"
