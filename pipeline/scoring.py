"""Per-channel-normalised scoring so large channels don't drown small ones."""

from __future__ import annotations

import math
from collections import defaultdict

from . import config
from .util import days_ago


def _zscores(values: dict[str, float]) -> dict[str, float]:
    if not values:
        return {}
    xs = list(values.values())
    mean = sum(xs) / len(xs)
    var = sum((x - mean) ** 2 for x in xs) / len(xs)
    std = math.sqrt(var)
    if std < 1e-9:
        return {k: 0.0 for k in values}
    return {k: (v - mean) / std for k, v in values.items()}


def score_videos(videos: list[dict]) -> None:
    """Attach a 'score' (and 'quality'/'popularity' debug fields) to each video in place."""
    by_channel: dict[str, list[dict]] = defaultdict(list)
    for v in videos:
        by_channel[v["channel_id"]].append(v)

    for group in by_channel.values():
        quality_raw = {}
        pop_raw = {}
        for v in group:
            views = max(v.get("views", 0), 0)
            likes = max(v.get("likes", 0), 0)
            # smoothed like/view ratio; priors avoid tiny-sample noise
            quality_raw[v["id"]] = (likes + 5) / (views + 500)
            pop_raw[v["id"]] = math.log10(views + 10)

        qz = _zscores(quality_raw)
        pz = _zscores(pop_raw)

        for v in group:
            fresh = math.exp(-days_ago(v["published"]) / config.FRESHNESS_HALF_LIFE_DAYS)
            v["quality"] = round(qz[v["id"]], 4)
            v["popularity"] = round(pz[v["id"]], 4)
            v["score"] = round(
                config.W_QUALITY * qz[v["id"]]
                + config.W_POPULARITY * pz[v["id"]]
                + config.W_FRESHNESS * fresh,
                4,
            )
