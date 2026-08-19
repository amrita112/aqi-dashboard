"""
Rate-limited HTTP client for the OpenAQ v3 API.

Enforces the free-tier limits (60 requests/minute, 2000/hour) by:
  - Sleeping so at least 1 second passes between consecutive requests
  - On 429, reading x-ratelimit-reset and sleeping for the window to reset,
    then retrying once
  - On a second 429 in a row, raising via response.raise_for_status()
    so the calling script crashes rather than continuing to hammer

Every script that talks to api.openaq.org MUST go through OpenAQClient.get().
Direct requests.get(...) calls to openaq.org would bypass the throttle and
risk another suspension.

Usage:
    from scripts.ingest.lib.openaq_client import OpenAQClient
    client = OpenAQClient(api_key)
    resp = client.get("/v3/locations", params={"countries_id": 9, "limit": 100})
    data = resp.json()
    client.print_stats()  # optional: log total requests + throttling time
"""

from __future__ import annotations

import time
from typing import Any, Dict, Optional

import requests

# OpenAQ free tier: 60 requests/minute. A 1.0s floor sits right at the 60 rpm
# ceiling with zero safety margin — any timing variance on OpenAQ's side tips
# us over. 1.2s caps us at ~50 rpm (16% under the limit), which has held up
# in practice. Confirmed on 2026-08-18 after a 1.0s run hit a 429 partway.
MIN_SECONDS_BETWEEN_REQUESTS = 1.2

BASE_URL = "https://api.openaq.org"


class OpenAQClient:
    """Throttled wrapper around requests.get() for the OpenAQ v3 API."""

    def __init__(self, api_key: str, base_url: str = BASE_URL):
        if not api_key:
            raise ValueError("api_key is required")
        self._session = requests.Session()
        self._session.headers.update({"X-API-Key": api_key})
        self._base_url = base_url.rstrip("/")
        self._last_request_at: float = 0.0
        self.stats: Dict[str, float] = {
            "requests": 0,
            "429s": 0,
            "throttle_sleep_s": 0.0,
        }

    def get(
        self,
        path: str,
        params: Optional[Dict[str, Any]] = None,
        timeout: int = 30,
        max_retries: int = 1,
    ) -> requests.Response:
        """Rate-limited GET.

        `path` is either a full URL or a path starting with '/v3/...'.
        Returns the requests.Response object; caller does .json() / .status_code.

        Throttles to <=1 rps. On 429 sleeps for x-ratelimit-reset then retries
        up to `max_retries` times. Raises HTTPError on repeated 429 to stop the
        calling loop from continuing to burn requests.
        """
        url = path if path.startswith("http") else f"{self._base_url}{path}"

        for attempt in range(max_retries + 1):
            # Throttle: keep at least MIN_SECONDS_BETWEEN_REQUESTS between calls.
            elapsed = time.monotonic() - self._last_request_at
            if elapsed < MIN_SECONDS_BETWEEN_REQUESTS:
                sleep_time = MIN_SECONDS_BETWEEN_REQUESTS - elapsed
                time.sleep(sleep_time)
                self.stats["throttle_sleep_s"] += sleep_time

            resp = self._session.get(url, params=params, timeout=timeout)
            self._last_request_at = time.monotonic()
            self.stats["requests"] += 1

            if resp.status_code == 429:
                self.stats["429s"] += 1
                reset_in = int(resp.headers.get("x-ratelimit-reset", 60))
                if attempt < max_retries:
                    print(f"  OpenAQ 429; sleeping {reset_in}s before retry")
                    time.sleep(reset_in + 1)
                    continue
                # Second 429 in a row — refuse to keep hammering.
                resp.raise_for_status()

            return resp

        # Unreachable given the loop structure; satisfies type checkers.
        return resp  # type: ignore[possibly-unbound]

    def print_stats(self) -> None:
        """Log cumulative rate-limit stats for this client's lifetime."""
        print(
            f"OpenAQClient stats: "
            f"requests={int(self.stats['requests'])}, "
            f"429s={int(self.stats['429s'])}, "
            f"throttle_sleep={self.stats['throttle_sleep_s']:.1f}s"
        )
