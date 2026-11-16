"""
Deciding when two city requests are for the same place.

People type the place themselves, so "Brahmapur", "Brahmapur, Odisha",
"brahmapur." and "Berhampur" all arrive for one city. To count requests per
place, each name is turned into one canonical KEY:

  1. basic_place():  lowercase, cut at the first comma or "(" (drops the
     state: "Brahmapur, Odisha", "Brahmapur (Odisha)"),
     punctuation -> spaces, runs of spaces -> one. "Brahmapur, Odisha" and
     " BRAHMAPUR. " both become "brahmapur".
  2. canonical_place():  look the result up in lib/place-aliases.json, which
     maps real spelling variants ("berhampur") to one name ("brahmapur").

This file is the ONLY place that rule lives. The alert job calls it; nothing
else re-implements it.

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

# Anything that is not a letter or digit in any script (so Devanagari, Odia
# etc. survive) becomes a space. `_` counts as a word character to `\w`, so it
# is listed explicitly.
_NON_WORD = re.compile(r"[\W_]+", re.UNICODE)


def basic_place(name: str) -> str:
    """The spelling-insensitive part of the rule: case, state suffix,
    punctuation and spacing. Returns "" for a name with nothing left."""
    text = unicodedata.normalize("NFKC", name or "").casefold()
    text = re.split(r"[,(]", text, maxsplit=1)[0]
    text = _NON_WORD.sub(" ", text)
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


def tally_places(
    rows: Iterable[Mapping[str, str]],
    aliases: Mapping[str, str],
) -> Dict[str, int]:
    """Requests per canonical place, counting each PERSON once per place.

    `rows` are what city_request_tally() returns: {"city": as typed,
    "requester": md5 of the email}. The database already allows only one
    request per person per spelling, but "Brahmapur" and "Berhampur, Odisha"
    from the same person are two rows there and one request here.
    """
    people: Dict[str, Set[str]] = {}
    for row in rows:
        key = canonical_place(row.get("city") or "", aliases)
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
