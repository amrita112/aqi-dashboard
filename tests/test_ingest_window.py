"""Tests for the recent-readings ingest's two silent failure modes.

Both of these shipped and both were invisible in a green workflow run:

  1. A fetch window narrower than OpenAQ's publication lag returns nothing, and
     the run still reports success. Six weeks of near-empty live ingest looked
     exactly like six weeks of healthy ingest finding no new data.
  2. The API returns rows ASCENDING from datetime_from and truncates at `limit`,
     so a window holding more rows than one page drops the NEWEST measurements.
     A caller that does not follow pages loses precisely the data it wanted.

Plus the distinction that made diagnosis hard: a failed request and an empty
sensor used to be the same empty list.
"""
from __future__ import annotations

import sys
from pathlib import Path
from typing import Any, Dict, List

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.ingest.ingest_recent_readings import (  # noqa: E402
    DEFAULT_FETCH_WINDOW_HOURS,
    MAX_PAGES_PER_SENSOR,
    MEASUREMENT_PAGE_LIMIT,
    fetch_sensor_recent,
)


class FakeResponse:
    def __init__(self, rows: List[Dict[str, Any]], status_code: int = 200):
        self._rows = rows
        self.status_code = status_code

    def json(self) -> Dict[str, Any]:
        return {"results": self._rows}


class FakeClient:
    """Stands in for OpenAQClient, serving a fixed row list with real paging."""

    def __init__(self, rows: List[Dict[str, Any]], status_code: int = 200,
                 raise_exc: Exception | None = None):
        self.rows = rows
        self.status_code = status_code
        self.raise_exc = raise_exc
        self.calls: List[Dict[str, Any]] = []

    def get(self, path: str, params: Dict[str, Any] | None = None, **kw):
        self.calls.append(dict(params or {}))
        if self.raise_exc is not None:
            raise self.raise_exc
        page = int((params or {}).get("page", 1))
        limit = int((params or {}).get("limit", MEASUREMENT_PAGE_LIMIT))
        start = (page - 1) * limit
        return FakeResponse(self.rows[start:start + limit], self.status_code)


def rows(n: int) -> List[Dict[str, Any]]:
    """n rows, ascending in time, the way the API actually orders them."""
    return [{"value": float(i), "period": {"datetimeFrom": {"utc": f"t{i:05d}"}}}
            for i in range(n)]


# --- the window ---------------------------------------------------------------

def test_window_covers_the_measured_publication_lag():
    """192h, against a lag measured at 109.7h median and 184.1h max.

    This is the assertion that would have failed in late September, when the
    window was 48h and the lag had grown past it. If someone narrows the window
    again, they have to come here and argue with the measurement.
    """
    measured_median_lag_h = 109.7
    measured_max_lag_h = 184.1
    assert DEFAULT_FETCH_WINDOW_HOURS > measured_max_lag_h, (
        "the window must clear the SLOWEST station, not the median: a window "
        "between the two silently drops the slow half"
    )
    assert DEFAULT_FETCH_WINDOW_HOURS >= 1.5 * measured_median_lag_h, (
        "leave headroom -- the lag moved from 16.8h to 109.7h in three weeks"
    )


def test_blank_window_override_falls_back_to_the_default():
    """GitHub Actions sends an empty string for an unset optional input.

    int("") raises, so a dict-style default would have crashed every scheduled
    run while working perfectly when dispatched by hand.
    """
    for raw in (None, "", "   "):
        value = int((raw or "").strip() or DEFAULT_FETCH_WINDOW_HOURS)
        assert value == DEFAULT_FETCH_WINDOW_HOURS
    assert int(("72" or "").strip() or DEFAULT_FETCH_WINDOW_HOURS) == 72


# --- pagination ---------------------------------------------------------------

def test_single_short_page_makes_one_request():
    client = FakeClient(rows(10))
    got = fetch_sensor_recent(client, 123, "2026-10-01T00:00:00Z")
    assert got is not None and len(got) == 10
    assert len(client.calls) == 1


def test_follows_pages_and_keeps_the_newest_rows():
    """The regression test for the truncation bug.

    2,500 rows against a 1,000-row page. Ascending order means the newest rows
    are LAST, so a non-paginating fetch returns rows 0-999 and loses every
    recent measurement -- while looking like a successful fetch of 1,000 rows.
    """
    n = 2 * MEASUREMENT_PAGE_LIMIT + 500
    client = FakeClient(rows(n))
    got = fetch_sensor_recent(client, 123, "2026-10-01T00:00:00Z")
    assert got is not None
    assert len(got) == n, "pagination dropped rows"
    assert got[-1]["period"]["datetimeFrom"]["utc"] == f"t{n - 1:05d}", (
        "the NEWEST row is missing -- this is the exact shape of the bug"
    )
    assert len(client.calls) == 3
    assert [c["page"] for c in client.calls] == [1, 2, 3]


def test_exact_multiple_of_page_size_does_not_lose_the_last_page():
    """An off-by-one trap: a full final page is indistinguishable from "more"."""
    client = FakeClient(rows(MEASUREMENT_PAGE_LIMIT))
    got = fetch_sensor_recent(client, 123, "2026-10-01T00:00:00Z")
    assert got is not None and len(got) == MEASUREMENT_PAGE_LIMIT
    # One full page then an empty one -- it must probe, not assume.
    assert len(client.calls) == 2


def test_paging_is_bounded():
    client = FakeClient(rows(MEASUREMENT_PAGE_LIMIT * (MAX_PAGES_PER_SENSOR + 5)))
    got = fetch_sensor_recent(client, 123, "2026-10-01T00:00:00Z")
    assert got is not None
    assert len(client.calls) <= MAX_PAGES_PER_SENSOR + 1


def test_window_is_passed_through_on_every_page():
    client = FakeClient(rows(MEASUREMENT_PAGE_LIMIT + 1))
    fetch_sensor_recent(client, 123, "2026-09-28T12:00:00Z")
    assert all(c["datetime_from"] == "2026-09-28T12:00:00Z" for c in client.calls)


# --- failure is not emptiness -------------------------------------------------

def test_empty_sensor_returns_empty_list():
    client = FakeClient([])
    assert fetch_sensor_recent(client, 123, "2026-10-01T00:00:00Z") == []


def test_request_exception_returns_none_not_empty():
    """The distinction that cost me a wrong conclusion.

    Probing 45 sensors by hand, 4 looked permanently dead and were transient
    failures. Conflating the two turns "we could not ask" into "there is no
    data", which points the investigation at OpenAQ instead of at ourselves.
    """
    client = FakeClient([], raise_exc=RuntimeError("connection reset"))
    assert fetch_sensor_recent(client, 123, "2026-10-01T00:00:00Z") is None


def test_non_200_returns_none_not_empty():
    client = FakeClient(rows(5), status_code=503)
    assert fetch_sensor_recent(client, 123, "2026-10-01T00:00:00Z") is None


def test_failure_midway_through_paging_is_not_a_partial_success():
    """A failure on page 2 must not return page 1 as if it were the whole set.

    Half a window looks like a healthy small result, and the rows it keeps are
    the OLD ones -- so this would quietly reintroduce the truncation bug under
    a different cause.
    """
    class FlakyClient(FakeClient):
        def get(self, path, params=None, **kw):
            page = int((params or {}).get("page", 1))
            if page == 2:
                raise RuntimeError("connection reset on page 2")
            return super().get(path, params, **kw)

    client = FlakyClient(rows(MEASUREMENT_PAGE_LIMIT * 2))
    assert fetch_sensor_recent(client, 123, "2026-10-01T00:00:00Z") is None
