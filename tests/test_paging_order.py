"""
Paging through Supabase results must use a fixed sort order.

The ingest jobs fetch big result sets 1000 rows at a time ("give me rows
0-999, then 1000-1999, ..."). Postgres only promises the same row order from
one request to the next when the query says how to sort. Without that, page 2
can repeat rows from page 1 and miss others -- silently. For rollup_daily that
means a wrong daily mean; for prune_raw it means comparing wrong counts before
deleting raw data.

The fake client below behaves like Postgres at its worst: an unsorted query
comes back in a different shuffled order on every request. A sorted query
comes back sorted. So these tests pass only if every paged query sorts on a
unique key.

Run:  /usr/bin/python3 -m pytest tests/test_paging_order.py -v
"""

from __future__ import annotations

import random
import sys
from datetime import date
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))

from scripts.ingest import prune_raw, rollup_daily  # noqa: E402

DAY = date(2026, 11, 10)
SMALL_PAGE = 7  # tiny page size so a handful of rows spans many pages


class _Result:
    def __init__(self, data):
        self.data = data


class FakeQuery:
    def __init__(self, client, table):
        self.client, self.table = client, table
        self.filters, self.sort_cols = [], []
        self.lo, self.hi = 0, None

    def select(self, *_a, **_k):
        return self

    def eq(self, col, val):
        self.filters.append(lambda r: r.get(col) == val)
        return self

    def in_(self, col, vals):
        vals = set(vals)
        self.filters.append(lambda r: r.get(col) in vals)
        return self

    # Every test row already belongs to DAY, so the date bounds are no-ops.
    def gte(self, *_a):
        return self

    def lt(self, *_a):
        return self

    def order(self, col, *_a, **_k):
        self.sort_cols.append(col)
        return self

    def range(self, lo, hi):
        self.lo, self.hi = lo, hi
        return self

    def execute(self):
        rows = [r for r in self.client.tables[self.table]
                if all(f(r) for f in self.filters)]
        if self.sort_cols:
            # Sorted on a unique key: the same order on every request.
            rows.sort(key=lambda r: tuple(r[c] for c in self.sort_cols))
        else:
            # Unsorted: any order, and a different one each time.
            self.client.rng.shuffle(rows)
        self.client.sorts.setdefault(self.table, []).append(tuple(self.sort_cols))
        return _Result(rows[self.lo:self.hi + 1])


class FakeClient:
    def __init__(self, tables):
        self.tables = tables
        self.rng = random.Random(0)
        self.sorts = {}

    def table(self, name):
        return FakeQuery(self, name)


def _make_tables(n_readings=30):
    readings, measurements, daily = [], [], []
    for i in range(n_readings):
        rid = f"r{i:03d}"
        readings.append({"id": rid, "monitor_id": f"m{i % 3}", "source": "openaq",
                         "recorded_at": f"2026-11-10T{i % 18:02d}:00:00+00:00"})
        for p in ("pm25", "pm10", "no2"):
            measurements.append({"reading_id": rid, "pollutant": p, "value": float(i)})
    for m in range(3):
        for p in ("pm25", "pm10", "no2"):
            daily.append({"monitor_id": f"m{m}", "pollutant": p,
                          "date": DAY.isoformat(), "count": n_readings // 3})
    return {"readings": readings, "measurements": measurements, "readings_daily": daily}


def test_rollup_fetch_returns_each_measurement_once(monkeypatch):
    monkeypatch.setattr(rollup_daily, "PAGE", SMALL_PAGE)
    tables = _make_tables()
    client = FakeClient(tables)
    joined = rollup_daily.fetch_day_measurements(client, DAY)

    got = sorted(zip(joined["monitor_id"], joined["pollutant"], joined["value"]))
    want = sorted((f"m{int(m['reading_id'][1:]) % 3}", m["pollutant"], m["value"])
                  for m in tables["measurements"])
    assert got == want  # nothing repeated, nothing skipped
    assert all(client.sorts["readings"]) and all(client.sorts["measurements"])


def test_prune_verify_counts_each_row_once(monkeypatch):
    monkeypatch.setattr(prune_raw, "PAGE", SMALL_PAGE)
    tables = _make_tables()
    client = FakeClient(tables)
    ok, why, stats = prune_raw.verify_day(client, DAY)

    assert (ok, why) == (True, "ok")
    assert stats["readings"] == 30
    assert stats["measurements"] == 90
    assert stats["rollup_rows"] == 9
    assert all(client.sorts["readings"]) and all(client.sorts["measurements"])
    assert all(client.sorts["readings_daily"])
