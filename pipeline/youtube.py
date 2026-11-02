"""Thin YouTube Data API v3 client (stdlib only) with quota accounting."""

from __future__ import annotations

import json
import time
import urllib.parse
import urllib.request
from typing import Iterator

API = "https://www.googleapis.com/youtube/v3/"


class Quota:
    """Tracks approximate quota units used (daily free budget is 10,000)."""

    def __init__(self) -> None:
        self.units = 0

    def add(self, n: int) -> None:
        self.units += n


class YouTube:
    def __init__(self, key: str, quota: Quota | None = None) -> None:
        self.key = key
        self.quota = quota or Quota()

    def _get(self, endpoint: str, params: dict, cost: int) -> dict:
        params = {**params, "key": self.key}
        url = API + endpoint + "?" + urllib.parse.urlencode(params)
        last_err: Exception | None = None
        for attempt in range(4):
            try:
                req = urllib.request.Request(url, headers={"Accept": "application/json"})
                with urllib.request.urlopen(req, timeout=30) as resp:
                    body = json.loads(resp.read().decode("utf-8"))
                self.quota.add(cost)
                return body
            except urllib.error.HTTPError as e:
                detail = e.read().decode("utf-8", "ignore")
                # quota / rate errors are not worth retrying blindly
                if e.code in (403, 400):
                    raise RuntimeError(f"API error {e.code} on {endpoint}: {detail[:300]}") from e
                last_err = e
            except Exception as e:  # noqa: BLE001  (network hiccups -> retry)
                last_err = e
            time.sleep(1.5 * (attempt + 1))
        raise RuntimeError(f"Request failed after retries: {endpoint}: {last_err}")

    # ---- endpoints ----

    def channel_by_handle(self, handle: str) -> dict | None:
        h = handle.lstrip("@")
        body = self._get(
            "channels",
            {"part": "snippet,contentDetails", "forHandle": h, "maxResults": 1},
            cost=1,
        )
        items = body.get("items") or []
        return items[0] if items else None

    def search_channel(self, name: str) -> dict | None:
        body = self._get(
            "search",
            {"part": "snippet", "q": name, "type": "channel", "maxResults": 1},
            cost=100,  # search is expensive; only a fallback
        )
        items = body.get("items") or []
        return items[0] if items else None

    def playlist_items(self, playlist_id: str) -> Iterator[dict]:
        """Yield playlist items (newest first for uploads playlists)."""
        page = None
        while True:
            params = {
                "part": "contentDetails",
                "playlistId": playlist_id,
                "maxResults": 50,
            }
            if page:
                params["pageToken"] = page
            body = self._get("playlistItems", params, cost=1)
            for it in body.get("items", []):
                yield it
            page = body.get("nextPageToken")
            if not page:
                break

    def playlists(self, channel_id: str) -> Iterator[dict]:
        page = None
        while True:
            params = {
                "part": "snippet,contentDetails",
                "channelId": channel_id,
                "maxResults": 50,
            }
            if page:
                params["pageToken"] = page
            body = self._get("playlists", params, cost=1)
            for it in body.get("items", []):
                yield it
            page = body.get("nextPageToken")
            if not page:
                break

    def videos(self, ids: list[str]) -> list[dict]:
        out: list[dict] = []
        for i in range(0, len(ids), 50):
            chunk = ids[i : i + 50]
            body = self._get(
                "videos",
                {
                    "part": "snippet,contentDetails,statistics,status,liveStreamingDetails",
                    "id": ",".join(chunk),
                    "maxResults": 50,
                },
                cost=1,
            )
            out.extend(body.get("items", []))
        return out
