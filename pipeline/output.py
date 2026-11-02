"""Write compact JSON for the site into site/public/data/."""

from __future__ import annotations

import shutil

from . import config
from .util import now, save_json


def _shard_key(vid: str) -> str:
    c = vid[0].lower() if vid else "_"
    return c if c.isalnum() else "_"


def write_site_data(
    videos: list[dict],
    channels: list[dict],
    subjects: list[dict],
    neighbours: dict[str, list[str]],
    courses: list[dict],
    playlists: list[dict] | None = None,
    vectors: dict | None = None,
) -> dict:
    out = config.OUT_DIR
    out.mkdir(parents=True, exist_ok=True)

    ch_index = {c["channel_id"]: i for i, c in enumerate(channels)}
    subj_index = {s["id"]: i for i, s in enumerate(subjects)}

    # videos.json (sorted best-first; compact short keys)
    videos = sorted(videos, key=lambda v: v.get("score", 0), reverse=True)
    v_arr = []
    for v in videos:
        v_arr.append(
            {
                "i": v["id"],
                "t": v["title"],
                "c": ch_index[v["channel_id"]],
                "p": v["published"][:10],
                "d": v["duration"],
                "v": v.get("views", 0),
                "s": v.get("score", 0),
                "u": [subj_index[s] for s in v.get("subjects", []) if s in subj_index],
            }
        )
    total = 0
    total += save_json(out / "videos.json", v_arr, minify=True)

    total += save_json(
        out / "channels.json",
        [
            {
                "id": c["channel_id"],
                "name": c["name"],
                "handle": c["handle"],
                "group": c["group"],
                "thumb": c.get("thumb", ""),
            }
            for c in channels
        ],
        minify=True,
    )

    total += save_json(
        out / "subjects.json",
        [
            {"id": s["id"], "name": s["name"], "section": s["section"], "code": s.get("code", "")}
            for s in subjects
        ],
        minify=True,
    )

    total += save_json(out / "courses.json", courses, minify=True)
    total += save_json(out / "playlists.json", playlists or [], minify=True)
    if vectors:
        total += save_json(out / "vectors.json", vectors, minify=True)

    # sharded neighbours
    sim_dir = out / "similar"
    if sim_dir.exists():
        shutil.rmtree(sim_dir)
    sim_dir.mkdir(parents=True, exist_ok=True)
    shards: dict[str, dict] = {}
    for vid, nbrs in neighbours.items():
        shards.setdefault(_shard_key(vid), {})[vid] = nbrs
    for key, obj in shards.items():
        total += save_json(sim_dir / f"{key}.json", obj, minify=True)

    # descriptions: sharded, loaded lazily on the watch page (kept out of videos.json)
    desc_dir = out / "desc"
    if desc_dir.exists():
        shutil.rmtree(desc_dir)
    desc_dir.mkdir(parents=True, exist_ok=True)
    dshards: dict[str, dict] = {}
    for v in videos:
        d = v.get("description")
        if d:
            dshards.setdefault(_shard_key(v["id"]), {})[v["id"]] = d
    for key, obj in dshards.items():
        total += save_json(desc_dir / f"{key}.json", obj, minify=True)

    longs = sum(1 for v in videos if v["duration"] >= config.LONG_DURATION_S)
    meta = {
        "updated": now().isoformat(timespec="seconds"),
        "videos": len(videos),
        "channels": len(channels),
        "subjects": len(subjects),
        "longs": longs,
        "shards": len(shards),
        "bytes": total,
    }
    total += save_json(out / "meta.json", meta, minify=True)
    meta["bytes"] = total
    return meta
