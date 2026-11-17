"""
Deciding when two city requests are for the same place.

People type the place themselves, so "Brahmapur", "Brahmapur, Odisha",
"brahmapur." and "Berhampur" all arrive for one city. To count requests per
place, each name is turned into one canonical KEY:

  1. basic_place():  Unicode-normalise (NFKC: full-width and look-alike
     characters become their plain form), lowercase, cut at the first comma
     or "(" (drops the state: "Brahmapur, Odisha", "Brahmapur (Odisha)"),
     anything that is not a letter, a combining mark or a digit -> a space,
     runs of spaces -> one. "Brahmapur, Odisha" and " BRAHMAPUR. " both
     become "brahmapur".
  2. canonical_place():  look the result up in lib/place-aliases.json, which
     maps real spelling variants ("berhampur") to one name ("brahmapur").

THE SAME RULE EXISTS IN TWO LANGUAGES, ON PURPOSE. The app's live count in the
city-request form needs it in TypeScript (lib/place-names.ts), and this job
needs it in Python. They cannot drift because both are tested against one
cases file, tests/fixtures/place_names/cases.json (tests/test_threshold_alerts.py
and tests/api/place-names.test.ts), and both read the one alias file.

The app stores step 1's result on each request (city_requests.place_key,
migration 29); aliases are applied when counting, never stored, so editing the
alias file changes counts at once without touching the database.

Fuzzy matching (near_misses) is only ever a SUGGESTION in the alert, never an
automatic merge: "Raipur" and "Jaipur" are 83% similar and are different
cities. If a suggestion is right, add a line to the alias file.
"""
from __future__ import annotations

import json
import re
import unicodedata
from difflib import SequenceMatcher
from pathlib import Path
from typing import Dict, Iterable, List, Mapping, Set, Tuple

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_ALIASES_PATH = REPO_ROOT / "lib" / "place-aliases.json"

# Two keys at least this similar (0-1, difflib ratio) are reported as a
# possible duplicate. 0.85 catches "bhubaneswar"/"bhubaneshwar" (0.96) and
# "indore"/"indor" (0.91) but not "raipur"/"jaipur" (0.83), which are
# different cities.
DEFAULT_NEAR_MISS_RATIO = 0.85


def _keep(ch: str) -> str:
    r"""A character is kept if its Unicode category is a Letter (L*), a Mark
    (M*: the vowel signs and viramas of Devanagari, Odia etc., without which
    "ब्रह्मपुर" falls apart) or a Number (N*). Everything else -- punctuation,
    symbols, spaces, "_" -- becomes a space. Categories, not Python's `\w`,
    because the TypeScript copy can say exactly the same thing
    (/[^\p{L}\p{M}\p{N}]/u)."""
    return ch if unicodedata.category(ch)[0] in "LMN" else " "


def basic_place(name: str) -> str:
    """The spelling-insensitive part of the rule: case, state suffix,
    punctuation and spacing. Returns "" for a name with nothing left.

    `.lower()`, not `.casefold()`: JavaScript has no casefold, and the app
    must produce the identical key."""
    text = unicodedata.normalize("NFKC", name or "").lower()
    text = re.split(r"[,(]", text, maxsplit=1)[0]
    text = "".join(_keep(ch) for ch in text)
    return " ".join(text.split())


def load_aliases(path: Path = DEFAULT_ALIASES_PATH) -> Dict[str, str]:
    """Read the alias file. Both sides go through basic_place(), so the file
    can be written in any capitalisation. Raises ValueError on a chain
    (a canonical name that is itself listed as a variant), because a chain
    means the file says two contradictory things about one name."""
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    aliases = {basic_place(k): basic_place(v) for k, v in raw.get("aliases", {}).items()}
    chained = sorted({v for v in aliases.values() if v in aliases and aliases[v] != v})
    if chained:
        raise ValueError(f"place-aliases.json: these canonical names are also listed as variants: {chained}")
    return aliases


def canonical_place(name: str, aliases: Mapping[str, str]) -> str:
    """The key a request is counted under."""
    key = basic_place(name)
    return aliases.get(key, key)


def row_key(row: Mapping[str, str], aliases: Mapping[str, str]) -> str:
    """The key one tally row is counted under.

    Uses the key STORED on the row (place_key, written by the app since
    migration 29) so this job counts exactly what the public form shows, and
    applies the aliases on top. A row without one (none should exist after
    migration 29's backfill) falls back to computing it from the city."""
    stored = row.get("place_key")
    if stored is None:
        return canonical_place(row.get("city") or "", aliases)
    return aliases.get(stored, stored)


def key_drift(rows: Iterable[Mapping[str, str]]) -> int:
    """How many rows have a stored place_key that differs from what this file
    computes from the city as typed. Should be 0: the app (lib/place-names.ts)
    and this file follow one rule, checked by a shared cases file. Non-zero
    means one copy changed without the other, or the database's backfill
    (migration 29, which only had SQL to work with) read an unusual name
    differently. A count only: the names are never printed."""
    return sum(
        1 for r in rows
        if r.get("place_key") is not None and r.get("place_key") != basic_place(r.get("city") or "")
    )


def tally_places(
    rows: Iterable[Mapping[str, str]],
    aliases: Mapping[str, str],
) -> Dict[str, int]:
    """Requests per canonical place, counting each PERSON once per place.

    `rows` are what city_request_tally() returns: {"city": as typed,
    "place_key": the stored key, "requester": md5 of the email}. The database
    allows only one request per person per spelling, but "Brahmapur" and
    "Berhampur, Odisha" from the same person are two rows there and one
    request here -- the same as the public count, city_request_count_for().
    """
    people: Dict[str, Set[str]] = {}
    for row in rows:
        key = row_key(row, aliases)
        if not key:
            continue
        people.setdefault(key, set()).add(row.get("requester") or "")
    return {key: len(who) for key, who in people.items()}


def near_misses(
    counts: Mapping[str, int],
    min_count: int,
    ratio: float = DEFAULT_NEAR_MISS_RATIO,
) -> List[Tuple[str, str, float]]:
    """Pairs of different keys that look like one place, most similar first.

    Only keys with at least `min_count` requests are considered. That keeps
    one-off typos out, and matters for privacy: the repo is public, so a name
    typed by one person (which could be anything) is never put in an issue.
    """
    keys = sorted(k for k, n in counts.items() if n >= min_count)
    pairs = []
    for i, a in enumerate(keys):
        for b in keys[i + 1:]:
            r = SequenceMatcher(None, a, b).ratio()
            if r >= ratio:
                pairs.append((a, b, round(r, 3)))
    pairs.sort(key=lambda p: (-p[2], p[0], p[1]))
    return pairs


def display_name(key: str) -> str:
    """"brahmapur" -> "Brahmapur", for issue titles."""
    return " ".join(w[:1].upper() + w[1:] for w in key.split())
