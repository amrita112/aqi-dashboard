"""
Daily check: has the petition, or any one place's city requests, reached a
milestone? If so, open a GitHub issue -- once -- so GitHub emails you.

WHY A GITHUB ISSUE. It needs no new service, no email account or password in
the repo, and no settings change: the workflow declares `issues: write` for
its own token, and GitHub emails people about new issues by default. The
issue also gives you a place to note what you did about it.

ONCE PER MILESTONE, WITH NO STATE TABLE. Each issue carries a hidden marker,
e.g. `<!-- threshold-alert: city:brahmapur:50 -->`, and a fixed title. Before
opening one, the job lists every issue in the repo, open AND closed, and skips
any milestone that already has one. Closing the issue keeps it quiet; DELETING
the issue re-arms that milestone.

WHAT IS COUNTED
  petition     petition_count(): live (unexpired) signatures.
  city         city_request_tally(): one row per live request, place as typed
               plus an md5 fingerprint of the email. Places are matched by
               scripts/alerts/place_names.py and each person counts once per
               place. The address never leaves the database.

WHAT IS NEVER WRITTEN to the issue or the log (the repo is PUBLIC): names,
emails, or any place name typed by fewer than NEAR_MISS_MIN_COUNT people.

Settings (environment variables; the workflow fills them from its inputs):
  PETITION_THRESHOLDS      comma-separated, default "100"
  CITY_REQUEST_THRESHOLDS  comma-separated, default "50"
  NEAR_MISS_MIN_COUNT      default 3
  NEAR_MISS_RATIO          default 0.85
  ALERT_MENTION            GitHub login to @mention (default: repo owner;
                           "none" to switch off)
  DRY_RUN                  "1"/"true": print what would be opened, open nothing
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GITHUB_TOKEN, GITHUB_REPOSITORY

Run locally (dry run; GITHUB_TOKEN optional -- without it the once-only check
is skipped and every crossed milestone is listed):
  DRY_RUN=1 python -m scripts.alerts.threshold_alerts
"""
from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from scripts.alerts.place_names import (  # noqa: E402
    DEFAULT_NEAR_MISS_RATIO,
    display_name,
    load_aliases,
    near_misses,
    tally_places,
)

# The promises: 100 signatures is the petition milestone; 50 requests is the
# number CityRequestForm shows (CITY_REQUEST_THRESHOLD in lib/api/petition.ts,
# checked by tests/test_threshold_alerts.py).
DEFAULT_PETITION_THRESHOLDS = (100,)
DEFAULT_CITY_THRESHOLDS = (50,)
DEFAULT_NEAR_MISS_MIN_COUNT = 3

LABEL = "threshold-alert"
MARKER = "<!-- threshold-alert: {key} -->"
PAGE = 1000  # PostgREST returns at most 1000 rows per request on Supabase.


@dataclass(frozen=True)
class Alert:
    key: str     # stable identity, e.g. "petition:100" or "city:brahmapur:50"
    title: str
    body: str


# ─── Pure logic (tested) ────────────────────────────────────────────────────

def parse_thresholds(text: Optional[str], default: Sequence[int]) -> List[int]:
    """"100, 250" -> [100, 250]. Blank -> default. Anything not a positive
    whole number is an error, not silently ignored: a typo in a threshold
    would otherwise mean an alert that never fires."""
    if text is None or not text.strip():
        return sorted(set(default))
    out = set()
    for part in text.split(","):
        part = part.strip()
        if not part:
            continue
        if not part.isdigit() or int(part) <= 0:
            raise ValueError(f"threshold {part!r} is not a positive whole number")
        out.add(int(part))
    return sorted(out)


def due_alerts(
    petition_count: int,
    place_counts: Mapping[str, int],
    petition_thresholds: Sequence[int],
    city_thresholds: Sequence[int],
    near_miss_min_count: int = DEFAULT_NEAR_MISS_MIN_COUNT,
    near_miss_ratio: float = DEFAULT_NEAR_MISS_RATIO,
    mention: Optional[str] = None,
) -> List[Alert]:
    """Every milestone currently reached, whether or not it was already
    announced (already_announced() filters that). Counts at or above the
    threshold count as reached."""
    ping = f"\n\n@{mention}" if mention else ""
    pairs = near_misses(place_counts, near_miss_min_count, near_miss_ratio)
    alerts: List[Alert] = []

    for t in petition_thresholds:
        if petition_count >= t:
            key = f"petition:{t}"
            alerts.append(Alert(
                key=key,
                title=f"Petition reached {t} signature{'s' if t != 1 else ''}",
                body=(
                    f"The petition has **{petition_count}** live signatures "
                    f"(milestone: {t}).\n\n"
                    "Opened automatically by the daily threshold-alert job; it will "
                    "not be opened again for this milestone, even if closed."
                    f"{ping}\n\n{MARKER.format(key=key)}"
                ),
            ))

    for place, n in sorted(place_counts.items()):
        for t in city_thresholds:
            if n < t:
                continue
            key = f"city:{place}:{t}"
            similar = [(b if a == place else a, r) for a, b, r in pairs if place in (a, b)]
            hint = ""
            if similar:
                lines = "\n".join(
                    f"- {display_name(o)} ({place_counts[o]} requests, {round(r * 100)}% similar)"
                    for o, r in similar
                )
                hint = (
                    "\n\nPossibly the same place, counted separately:\n" + lines +
                    "\nIf so, add the variant to `lib/place-aliases.json`."
                )
            alerts.append(Alert(
                key=key,
                title=f"City requests: {display_name(place)} reached {t}",
                body=(
                    f"**{n}** people have asked for **{display_name(place)}** to be "
                    f"added (milestone: {t}). Spellings are matched by "
                    "`scripts/alerts/place_names.py` and `lib/place-aliases.json`; "
                    "each person counts once."
                    f"{hint}\n\n"
                    "To see the requests: `SELECT city, count(*) FROM city_requests "
                    "GROUP BY city ORDER BY 2 DESC;` in the Supabase SQL editor."
                    f"{ping}\n\n{MARKER.format(key=key)}"
                ),
            ))

    # Two spellings that are each under a milestone but together are over it:
    # without this, a split count would never alert at all.
    for a, b, r in pairs:
        combined = place_counts[a] + place_counts[b]
        for t in city_thresholds:
            if combined >= t and place_counts[a] < t and place_counts[b] < t:
                key = f"near-miss:{a}|{b}:{t}"
                alerts.append(Alert(
                    key=key,
                    title=f"City requests: {display_name(a)} + {display_name(b)} together reach {t}?",
                    body=(
                        f"{display_name(a)} has {place_counts[a]} requests and "
                        f"{display_name(b)} has {place_counts[b]} "
                        f"({round(r * 100)}% similar names). Together: **{combined}**, "
                        f"over the milestone of {t}; separately, neither is.\n\n"
                        "If they are the same place, add one as an alias of the other in "
                        "`lib/place-aliases.json`; the next daily run then opens the "
                        "normal milestone issue. If they are different places, close this."
                        f"{ping}\n\n{MARKER.format(key=key)}"
                    ),
                ))
    return alerts


def already_announced(alert: Alert, issues: Iterable[Mapping[str, Any]]) -> bool:
    """True if any existing issue (open or closed) carries this alert's marker
    or has exactly its title."""
    marker = MARKER.format(key=alert.key)
    for issue in issues:
        if marker in (issue.get("body") or "") or issue.get("title") == alert.title:
            return True
    return False


def truthy(value: Optional[str]) -> bool:
    return (value or "").strip().lower() in ("1", "true", "yes")


# ─── Supabase ───────────────────────────────────────────────────────────────

def fetch_counts(client: Any, aliases: Mapping[str, str]):
    """(petition count, {place key: people})."""
    petition = client.rpc("petition_count").execute().data or 0
    rows: List[Dict[str, str]] = []
    start = 0
    while True:
        page = (
            client.rpc("city_request_tally")
            .order("requester").order("city")
            .range(start, start + PAGE - 1)
            .execute().data or []
        )
        rows.extend(page)
        if len(page) < PAGE:
            break
        start += PAGE
    return int(petition), tally_places(rows, aliases)


# ─── GitHub ─────────────────────────────────────────────────────────────────

class GitHub:
    def __init__(self, token: str, repo: str, api: str = "https://api.github.com"):
        import requests  # only needed when talking to GitHub

        self.repo = repo
        self.api = api.rstrip("/")
        self.http = requests.Session()
        self.http.headers.update({
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        })

    def all_issues(self) -> List[Dict[str, Any]]:
        """Every issue, open and closed. (The list includes pull requests;
        they never carry the marker, so they do no harm.)"""
        out: List[Dict[str, Any]] = []
        page = 1
        while True:
            r = self.http.get(
                f"{self.api}/repos/{self.repo}/issues",
                params={"state": "all", "per_page": 100, "page": page},
                timeout=30,
            )
            r.raise_for_status()
            batch = r.json()
            out.extend(batch)
            if len(batch) < 100:
                return out
            page += 1

    def ensure_label(self) -> bool:
        r = self.http.post(
            f"{self.api}/repos/{self.repo}/labels",
            json={"name": LABEL, "color": "d93f0b",
                  "description": "Opened by the daily threshold-alert job"},
            timeout=30,
        )
        return r.status_code in (201, 422)  # 422 = already exists

    def open_issue(self, alert: Alert, labelled: bool) -> str:
        payload: Dict[str, Any] = {"title": alert.title, "body": alert.body}
        if labelled:
            payload["labels"] = [LABEL]
        r = self.http.post(f"{self.api}/repos/{self.repo}/issues", json=payload, timeout=30)
        r.raise_for_status()
        return r.json().get("html_url", "")


# ─── Entry point ────────────────────────────────────────────────────────────

def main() -> int:
    dry_run = truthy(os.environ.get("DRY_RUN"))
    petition_thresholds = parse_thresholds(os.environ.get("PETITION_THRESHOLDS"), DEFAULT_PETITION_THRESHOLDS)
    city_thresholds = parse_thresholds(os.environ.get("CITY_REQUEST_THRESHOLDS"), DEFAULT_CITY_THRESHOLDS)
    min_count = int(os.environ.get("NEAR_MISS_MIN_COUNT") or DEFAULT_NEAR_MISS_MIN_COUNT)
    ratio = float(os.environ.get("NEAR_MISS_RATIO") or DEFAULT_NEAR_MISS_RATIO)
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    mention = os.environ.get("ALERT_MENTION") or repo.split("/")[0] or None
    if mention and mention.lower() == "none":
        mention = None

    from scripts.ingest.lib.supabase_client import make_client

    petition, places = fetch_counts(make_client(), load_aliases())
    print(f"Petition: {petition} live signatures (milestones {petition_thresholds})")
    print(f"City requests: {sum(places.values())} across {len(places)} places (milestones {city_thresholds})")
    # Only places at or above the privacy floor are named in the (public) log.
    for place, n in sorted(places.items(), key=lambda kv: -kv[1]):
        if n >= min_count:
            print(f"  {display_name(place)}: {n}")

    alerts = due_alerts(petition, places, petition_thresholds, city_thresholds, min_count, ratio, mention)

    token = os.environ.get("GITHUB_TOKEN", "")
    github = GitHub(token, repo, os.environ.get("GITHUB_API_URL", "https://api.github.com")) if token and repo else None
    if github is None and not dry_run:
        raise SystemExit("GITHUB_TOKEN and GITHUB_REPOSITORY are needed to open issues (or set DRY_RUN=1).")
    existing = github.all_issues() if github else []
    new = [a for a in alerts if not already_announced(a, existing)]

    print(f"Milestones reached: {len(alerts)}; already announced: {len(alerts) - len(new)}; new: {len(new)}")
    if not new:
        return 0
    labelled = github.ensure_label() if github and not dry_run else False
    for alert in new:
        if dry_run:
            print(f"[dry run] would open: {alert.title}")
        else:
            print(f"Opened: {alert.title} {github.open_issue(alert, labelled)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
