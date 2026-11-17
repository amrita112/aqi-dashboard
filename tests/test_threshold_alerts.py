"""The petition / city-request milestone alerts.

What matters: a milestone fires when it is reached, fires ONCE (an existing
issue, open or closed, silences it), spelling variants of one place count
together, one person counts once per place, and nothing typed by only a
handful of people is ever written into the public repo.

Run: /usr/bin/python3 -m pytest tests/test_threshold_alerts.py -q
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from scripts.alerts.place_names import (  # noqa: E402
    basic_place,
    canonical_place,
    key_drift,
    load_aliases,
    near_misses,
    tally_places,
)
from scripts.alerts.threshold_alerts import (  # noqa: E402
    DEFAULT_CITY_THRESHOLDS,
    DEFAULT_PETITION_THRESHOLDS,
    Alert,
    already_announced,
    due_alerts,
    parse_thresholds,
)

ALIASES = load_aliases()
PLACE_CASES = json.loads((ROOT / "tests" / "fixtures" / "place_names" / "cases.json").read_text(encoding="utf-8"))


# ─── Shared cases: must agree with lib/place-names.ts ───────────────────────

@pytest.mark.parametrize("case", PLACE_CASES["cases"], ids=lambda c: repr(c["typed"]))
def test_shared_cases_file(case):
    """The same file is run by tests/api/place-names.test.ts against the
    TypeScript copy, so the public form count and the alert cannot drift."""
    assert basic_place(case["typed"]) == case["basic"]
    assert canonical_place(case["typed"], ALIASES) == case["key"]


def test_shared_alias_groups():
    for canonical, group in PLACE_CASES["groups"].items():
        assert sorted({canonical} | {v for v, k in ALIASES.items() if k == canonical}) == group


# ─── Place names ────────────────────────────────────────────────────────────

@pytest.mark.parametrize("typed", [
    "Brahmapur", "brahmapur", "  BRAHMAPUR  ", "Brahmapur, Odisha",
    "Brahmapur,Odisha", "Brahmapur.", "Berhampur", "Berhampur, Odisha",
    "Behrampur", "Brahmapur (Odisha)",
])
def test_brahmapur_variants_are_one_place(typed):
    assert canonical_place(typed, ALIASES) == "brahmapur"


@pytest.mark.parametrize("typed,expected", [
    ("Bombay", "mumbai"), ("Bangalore", "bengaluru"), ("Calcutta", "kolkata"),
    ("Madras", "chennai"), ("Gurgaon, Haryana", "gurugram"), ("Poona", "pune"),
    ("New Delhi", "delhi"), ("new-delhi", "delhi"),
])
def test_common_renamed_cities(typed, expected):
    assert canonical_place(typed, ALIASES) == expected


def test_basic_rule():
    assert basic_place("  Navi   Mumbai!! ") == "navi mumbai"
    assert basic_place("Port_Blair") == "port blair"
    assert basic_place(",,,") == ""
    # Non-Latin scripts survive (only punctuation is removed).
    assert basic_place("ब्रह्मपुर, ओडिशा") == basic_place("ब्रह्मपुर")
    assert basic_place("ब्रह्मपुर") != ""


def test_different_west_bengal_city_is_not_merged():
    # Berhampore / Baharampur (West Bengal) is a different city.
    assert canonical_place("Berhampore", ALIASES) != "brahmapur"
    assert canonical_place("Baharampur", ALIASES) != "brahmapur"


def test_alias_file_has_no_chains_and_loads():
    raw = json.loads((ROOT / "lib" / "place-aliases.json").read_text())
    assert raw["aliases"], "alias file is empty"
    for variant, canon in ALIASES.items():
        assert canon not in ALIASES or ALIASES[canon] == canon, (variant, canon)


def test_alias_chain_is_rejected(tmp_path):
    bad = tmp_path / "a.json"
    bad.write_text(json.dumps({"aliases": {"a": "b", "b": "c"}}))
    with pytest.raises(ValueError):
        load_aliases(bad)


def test_stored_place_key_is_used_and_aliased():
    # The key stored by the app (migration 29) is what is counted; aliases are
    # applied on top. A row without one falls back to the city.
    rows = [
        {"city": "Berhampur", "place_key": "berhampur", "requester": "p1"},
        {"city": "Brahmapur, Odisha", "place_key": "brahmapur", "requester": "p2"},
        {"city": "Brahmapur", "requester": "p3"},                     # no key
        {"city": "Brahmapur", "place_key": "brahmapur", "requester": "p1"},  # p1 again
    ]
    assert tally_places(rows, ALIASES) == {"brahmapur": 3}


def test_key_drift_counts_disagreeing_rows():
    rows = [
        {"city": "Brahmapur, Odisha", "place_key": "brahmapur"},
        {"city": "Indore", "place_key": "indor"},       # disagrees
        {"city": "Pune"},                               # no key: not drift
    ]
    assert key_drift(rows) == 1


def test_one_person_counts_once_per_place_across_spellings():
    rows = [
        {"city": "Brahmapur", "requester": "p1"},
        {"city": "Berhampur, Odisha", "requester": "p1"},  # same person
        {"city": "brahmapur", "requester": "p2"},
        {"city": "Indore", "requester": "p1"},             # another place: counts
        {"city": " , ", "requester": "p3"},                # nothing left: skipped
    ]
    assert tally_places(rows, ALIASES) == {"brahmapur": 2, "indore": 1}


def test_near_misses_respect_floor_and_ratio():
    counts = {"bhubaneswar": 10, "bhubaneshwr": 4, "raipur": 9, "jaipur": 9, "indor": 1, "indore": 20}
    pairs = near_misses(counts, min_count=3, ratio=0.85)
    names = {(a, b) for a, b, _ in pairs}
    assert ("bhubaneshwr", "bhubaneswar") in names
    assert ("jaipur", "raipur") not in names           # 0.83: different cities
    assert all("indor" not in (a, b) for a, b in names)  # under the floor


# ─── Thresholds ─────────────────────────────────────────────────────────────

def test_parse_thresholds():
    assert parse_thresholds(None, (100,)) == [100]
    assert parse_thresholds("  ", (100,)) == [100]
    assert parse_thresholds("250, 100,100", (1,)) == [100, 250]
    for bad in ("abc", "0", "-5", "1.5"):
        with pytest.raises(ValueError):
            parse_thresholds(bad, (1,))


def test_defaults_match_the_promise_on_screen():
    assert DEFAULT_PETITION_THRESHOLDS == (100,)
    assert DEFAULT_CITY_THRESHOLDS == (50,)
    ts = (ROOT / "lib" / "api" / "petition.ts").read_text()
    m = re.search(r"CITY_REQUEST_THRESHOLD\s*=\s*(\d+)", ts)
    assert m and int(m.group(1)) == DEFAULT_CITY_THRESHOLDS[0]


def keys(alerts):
    return sorted(a.key for a in alerts)


def test_fires_at_and_above_threshold_not_below():
    assert keys(due_alerts(99, {"brahmapur": 49}, [100], [50])) == []
    assert keys(due_alerts(100, {"brahmapur": 50}, [100], [50])) == ["city:brahmapur:50", "petition:100"]
    assert keys(due_alerts(140, {"brahmapur": 80, "indore": 3}, [100], [50])) == ["city:brahmapur:50", "petition:100"]


def test_each_threshold_is_its_own_milestone():
    assert keys(due_alerts(260, {}, [100, 250], [50])) == ["petition:100", "petition:250"]


def test_split_spellings_raise_a_near_miss_alert():
    alerts = due_alerts(0, {"bhubaneswar": 30, "bhubaneshwr": 25}, [100], [50])
    assert keys(alerts) == ["near-miss:bhubaneshwr|bhubaneswar:50"]
    assert "place-aliases.json" in alerts[0].body


def test_city_alert_mentions_similar_names():
    alerts = due_alerts(0, {"bhubaneswar": 60, "bhubaneshwr": 5}, [100], [50])
    city = [a for a in alerts if a.key.startswith("city:")][0]
    assert "Bhubaneshwr (5 requests" in city.body


def test_mention_and_marker_in_body():
    a = due_alerts(100, {}, [100], [50], mention="someone")[0]
    assert "@someone" in a.body
    assert "<!-- threshold-alert: petition:100 -->" in a.body
    assert "@" not in due_alerts(100, {}, [100], [50], mention=None)[0].body.replace("<!--", "")


# ─── Once only ──────────────────────────────────────────────────────────────

ALERT = Alert(key="petition:100", title="Petition reached 100 signatures",
              body="x <!-- threshold-alert: petition:100 -->")


def test_not_announced_when_no_issue_exists():
    assert not already_announced(ALERT, [])
    assert not already_announced(ALERT, [{"title": "Something else", "body": "hi"}])


def test_an_open_or_closed_issue_with_the_marker_silences_it():
    for state in ("open", "closed"):
        assert already_announced(ALERT, [{"title": "renamed by hand", "state": state, "body": ALERT.body}])


def test_title_alone_also_silences_it():
    # e.g. the body was edited and the marker deleted.
    assert already_announced(ALERT, [{"title": ALERT.title, "body": None}])


def test_a_different_threshold_is_not_silenced():
    other = Alert(key="petition:250", title="Petition reached 250 signatures",
                  body="<!-- threshold-alert: petition:250 -->")
    assert not already_announced(other, [{"title": ALERT.title, "body": ALERT.body}])


def test_second_run_opens_nothing_new():
    """Run 1 opens issues; run 2, with those issues present, opens none."""
    alerts = due_alerts(120, {"brahmapur": 55}, [100], [50])
    opened = [{"title": a.title, "body": a.body, "state": "open"} for a in alerts]
    assert [a for a in alerts if not already_announced(a, opened)] == []


# ─── The job end to end, with fake Supabase and fake GitHub ─────────────────

class FakeQuery:
    def __init__(self, data):
        self.data = data
        self.start = 0
        self.stop = None

    def order(self, *_a, **_k):
        return self

    def range(self, start, stop):
        self.start, self.stop = start, stop
        return self

    def execute(self):
        if isinstance(self.data, list):
            return type("R", (), {"data": self.data[self.start:self.stop + 1]})()
        return type("R", (), {"data": self.data})()


class FakeSupabase:
    def __init__(self, petition, rows):
        self.petition, self.rows = petition, rows

    def rpc(self, name):
        return FakeQuery(self.petition if name == "petition_count" else self.rows)


class FakeGitHub:
    issues: list = []
    opened: list = []

    def __init__(self, *_a, **_k):
        pass

    def all_issues(self):
        return list(FakeGitHub.issues)

    def ensure_label(self):
        return True

    def open_issue(self, alert, labelled):
        FakeGitHub.opened.append(alert.title)
        FakeGitHub.issues.append({"title": alert.title, "body": alert.body, "state": "open"})
        return "https://example/issue"


def run_job(monkeypatch, petition, rows, **env):
    import scripts.alerts.threshold_alerts as job
    import scripts.ingest.lib.supabase_client as sc

    monkeypatch.setattr(sc, "make_client", lambda: FakeSupabase(petition, rows))
    monkeypatch.setattr(job, "GitHub", FakeGitHub)
    for k in ("DRY_RUN", "PETITION_THRESHOLDS", "CITY_REQUEST_THRESHOLDS", "ALERT_MENTION"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("GITHUB_TOKEN", "t")
    monkeypatch.setenv("GITHUB_REPOSITORY", "owner/repo")
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    assert job.main() == 0


def test_job_opens_once_then_stays_quiet(monkeypatch, capsys):
    FakeGitHub.issues, FakeGitHub.opened = [], []
    # 1,500 rows: more than one 1,000-row page, so paging is exercised.
    rows = [{"city": "Brahmapur, Odisha" if i % 2 else "Berhampur", "requester": f"p{i}"} for i in range(60)]
    rows += [{"city": f"Town{i}", "requester": f"q{i}"} for i in range(1440)]
    run_job(monkeypatch, 101, rows)
    assert sorted(FakeGitHub.opened) == ["City requests: Brahmapur reached 50", "Petition reached 100 signatures"]
    assert "@owner" in FakeGitHub.issues[0]["body"]

    run_job(monkeypatch, 150, rows)          # next day: nothing new
    assert len(FakeGitHub.opened) == 2

    out = capsys.readouterr().out
    assert "Town1" not in out                # one-person places never logged


def test_job_dry_run_opens_nothing(monkeypatch, capsys):
    FakeGitHub.issues, FakeGitHub.opened = [], []
    run_job(monkeypatch, 5, [], DRY_RUN="1", PETITION_THRESHOLDS="1")
    assert FakeGitHub.opened == []
    assert "[dry run] would open: Petition reached 1 signature" in capsys.readouterr().out


def test_job_warns_on_key_drift_without_naming_places(monkeypatch, capsys):
    FakeGitHub.issues, FakeGitHub.opened = [], []
    rows = [{"city": "Secretville", "place_key": "elsewhere", "requester": "p1"}]
    run_job(monkeypatch, 0, rows, DRY_RUN="1")
    out = capsys.readouterr().out
    assert "WARNING: 1 request(s) have a stored place_key" in out
    assert "Secretville" not in out and "Elsewhere" not in out
