"""Tests for the station list kept in Supabase (migration 32).

Two pieces, both with fake Supabase clients (no network):
  * scripts/ingest/lib/manifest.py -- the ingest's loader: table rows come back
    in the same shape the old JSON file had, and it falls back to the file
    (with a warning) when the table is empty or cannot be read.
  * scripts/ingest/bootstrap_stations.py -- the weekly writer: it upserts the
    sensors it found, deletes the ones no longer listed, and refuses to write
    anything if the new list is suspiciously short.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.ingest import bootstrap_stations as bs  # noqa: E402
from scripts.ingest.lib import manifest as mf  # noqa: E402


# ─── A fake Supabase client ──────────────────────────────────────────────────

class _Result:
    def __init__(self, data):
        self.data = data


class _Query:
    """Records the call chain; .execute() serves rows or raises."""

    def __init__(self, db, table):
        self.db, self.table, self.op = db, table, "select"
        self.lo, self.hi, self.payload, self.in_filter = 0, None, None, None

    def select(self, *_):
        return self

    def order(self, *_):
        return self

    def range(self, lo, hi):
        self.lo, self.hi = lo, hi
        return self

    def upsert(self, rows, **_):
        self.op, self.payload = "upsert", rows
        return self

    def delete(self):
        self.op = "delete"
        return self

    def in_(self, col, values):
        self.in_filter = (col, list(values))
        return self

    def execute(self):
        if self.table in self.db.errors:
            raise self.db.errors[self.table]
        self.db.calls.append((self.table, self.op, self.payload, self.in_filter))
        rows = self.db.tables.get(self.table, [])
        if self.op == "select":
            hi = len(rows) if self.hi is None else self.hi + 1
            return _Result(rows[self.lo:hi])
        return _Result(self.payload or [])


class FakeClient:
    def __init__(self, tables=None, errors=None):
        self.tables = tables or {}
        self.errors = errors or {}
        self.calls = []

    def table(self, name):
        return _Query(self, name)


# ─── Sample data ─────────────────────────────────────────────────────────────

MON_A, MON_B = "aaaaaaaa-0000-0000-0000-000000000001", "bbbbbbbb-0000-0000-0000-000000000002"

MONITORS = [
    {"id": MON_A, "name": "IGI Airport", "latitude": 28.56, "longitude": 77.094, "city": "Delhi NCR"},
    {"id": MON_B, "name": "Bandra", "latitude": 19.06, "longitude": 72.84, "city": "Mumbai"},
]
SENSORS = [
    {"sensor_id": 30, "monitor_id": MON_A, "parameter": "pm25", "openaq_location_id": 15,
     "updated_at": "2026-11-22T04:31:00+00:00"},
    {"sensor_id": 28, "monitor_id": MON_A, "parameter": "no2", "openaq_location_id": 15,
     "updated_at": "2026-11-22T04:31:00+00:00"},
    {"sensor_id": 900, "monitor_id": MON_B, "parameter": "pm10", "openaq_location_id": 7,
     "updated_at": "2026-11-15T04:31:00+00:00"},
]

FILE_MANIFEST = {
    "generated_at": "2026-10-18T09:05:57+00:00", "source": "openaq",
    "pollutants": ["no2", "pm10", "pm25", "so2"],
    "stations": [{"openaq_id": 1, "name": "From file", "latitude": 0, "longitude": 0,
                  "city": "Delhi NCR", "sensors": [{"sensor_id": 1, "parameter": "pm25"}],
                  "monitor_id": MON_A}],
}


@pytest.fixture
def manifest_file(tmp_path):
    p = tmp_path / "target_stations.json"
    p.write_text(json.dumps(FILE_MANIFEST))
    return p


@pytest.fixture(autouse=True)
def _auto_source(monkeypatch):
    monkeypatch.delenv("MANIFEST_SOURCE", raising=False)


# ─── Loader: rows -> manifest ────────────────────────────────────────────────

def test_rows_become_the_old_json_shape():
    m = mf.manifest_from_rows(SENSORS, MONITORS)
    assert set(m) == {"generated_at", "source", "pollutants", "stations"}
    assert m["generated_at"] == "2026-11-22T04:31:00+00:00"      # newest row's stamp
    assert m["pollutants"] == ["no2", "pm10", "pm25", "so2"]
    # Sorted by OpenAQ id: Bandra (7) before IGI Airport (15).
    assert [s["openaq_id"] for s in m["stations"]] == [7, 15]
    igi = m["stations"][1]
    assert igi == {
        "openaq_id": 15, "name": "IGI Airport", "latitude": 28.56, "longitude": 77.094,
        "city": "Delhi NCR", "monitor_id": MON_A,
        "sensors": [{"sensor_id": 28, "parameter": "no2"},
                    {"sensor_id": 30, "parameter": "pm25"}],
    }


def test_sensor_without_a_monitor_row_is_skipped():
    orphan = dict(SENSORS[0], sensor_id=1, monitor_id="no-such-monitor")
    m = mf.manifest_from_rows(SENSORS + [orphan], MONITORS)
    assert 1 not in {x["sensor_id"] for s in m["stations"] for x in s["sensors"]}


def test_loader_reads_the_table(manifest_file):
    client = FakeClient({"monitor_sensors": SENSORS, "monitors": MONITORS})
    logs = []
    m = mf.load_target_stations(client, path=manifest_file, log=logs.append)
    assert m["loaded_from"] == "supabase"
    assert len(m["stations"]) == 2
    assert not any("WARNING" in line for line in logs)


def test_loader_pages_past_the_row_cap(manifest_file, monkeypatch):
    """Supabase returns at most PAGE_SIZE rows; the loader must ask again."""
    monkeypatch.setattr(mf, "PAGE_SIZE", 2)
    client = FakeClient({"monitor_sensors": SENSORS, "monitors": MONITORS})
    m = mf.load_target_stations(client, path=manifest_file, log=lambda *_: None)
    assert sum(len(s["sensors"]) for s in m["stations"]) == 3


# ─── Loader: fallback to the file ────────────────────────────────────────────

def test_empty_table_falls_back_to_file_with_warning(manifest_file):
    client = FakeClient({"monitor_sensors": [], "monitors": MONITORS})
    logs = []
    m = mf.load_target_stations(client, path=manifest_file, log=logs.append)
    assert m["loaded_from"] == "file"
    assert m["stations"][0]["name"] == "From file"
    assert any("WARNING" in line and "empty" in line for line in logs)


def test_unreadable_table_falls_back_to_file_with_warning(manifest_file):
    client = FakeClient(errors={"monitor_sensors": RuntimeError("relation does not exist")})
    logs = []
    m = mf.load_target_stations(client, path=manifest_file, log=logs.append)
    assert m["loaded_from"] == "file"
    assert any("WARNING" in line and "does not exist" in line for line in logs)


def test_no_credentials_falls_back_to_file(manifest_file, monkeypatch):
    """client=None and no env vars: make_client exits; the loader carries on."""
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY", raising=False)
    logs = []
    m = mf.load_target_stations(None, path=manifest_file, log=logs.append)
    assert m["loaded_from"] == "file"
    assert any("WARNING" in line for line in logs)


def test_manifest_source_file_skips_the_table(manifest_file, monkeypatch):
    monkeypatch.setenv("MANIFEST_SOURCE", "file")
    client = FakeClient({"monitor_sensors": SENSORS, "monitors": MONITORS})
    m = mf.load_target_stations(client, path=manifest_file, log=lambda *_: None)
    assert m["loaded_from"] == "file"
    assert client.calls == []


def test_no_table_and_no_file_is_a_clear_error(tmp_path):
    client = FakeClient({"monitor_sensors": []})
    with pytest.raises(SystemExit, match="No station list"):
        mf.load_target_stations(client, path=tmp_path / "missing.json", log=lambda *_: None)


# ─── Bootstrap: the shrink guard ─────────────────────────────────────────────

def test_guard_passes_small_changes_and_first_run():
    bs.check_not_shrinking(620, 633)            # a few sensors retired: fine
    bs.check_not_shrinking(700, 633)            # growth: fine
    bs.check_not_shrinking(5, 0)                # nothing to compare with: fine


def test_guard_refuses_a_big_drop():
    with pytest.raises(SystemExit, match="REFUSING TO WRITE"):
        bs.check_not_shrinking(300, 633)


def test_guard_share_is_configurable():
    bs.check_not_shrinking(300, 633, min_share=0)          # deliberate override
    with pytest.raises(SystemExit):
        bs.check_not_shrinking(600, 633, min_share=0.99)


# ─── Bootstrap: writing the table ────────────────────────────────────────────

STATIONS = [
    {"openaq_id": 15, "name": "IGI Airport", "latitude": 28.56, "longitude": 77.094,
     "city": "Delhi NCR",
     "sensors": [{"sensor_id": 28, "parameter": "no2"}, {"sensor_id": 30, "parameter": "pm25"}]},
]


def test_sensor_rows_carry_monitor_and_location():
    rows = bs.sensor_rows(STATIONS, {15: MON_A}, "2026-11-23T00:00:00+00:00")
    assert rows == [
        {"sensor_id": 28, "monitor_id": MON_A, "parameter": "no2",
         "openaq_location_id": 15, "updated_at": "2026-11-23T00:00:00+00:00"},
        {"sensor_id": 30, "monitor_id": MON_A, "parameter": "pm25",
         "openaq_location_id": 15, "updated_at": "2026-11-23T00:00:00+00:00"},
    ]


def test_write_upserts_then_deletes_only_unlisted_sensors():
    client = FakeClient()
    rows = bs.sensor_rows(STATIONS, {15: MON_A}, "t")
    bs.write_sensor_table(client, rows, existing={28, 30, 31, 99})
    ops = [(t, op) for t, op, _, _ in client.calls]
    assert ops == [("monitor_sensors", "upsert"), ("monitor_sensors", "delete")]
    _, _, _, in_filter = client.calls[1]
    assert in_filter == ("sensor_id", [31, 99])


def test_write_with_nothing_stale_deletes_nothing():
    client = FakeClient()
    bs.write_sensor_table(client, bs.sensor_rows(STATIONS, {15: MON_A}, "t"), existing={28})
    assert [op for _, op, _, _ in client.calls] == ["upsert"]


def test_missing_table_is_reported_as_none():
    client = FakeClient(errors={"monitor_sensors": RuntimeError("PGRST205 not found")})
    assert bs.read_existing_sensor_ids(client) is None


def test_other_read_errors_are_not_swallowed():
    client = FakeClient(errors={"monitor_sensors": RuntimeError("timeout")})
    with pytest.raises(RuntimeError):
        bs.read_existing_sensor_ids(client)
