"""End-to-end build: resolve -> collect -> details -> filter -> score -> tag
-> similar -> write site data. Run: python -m pipeline.build [--only h1,h2] [--limit N]
"""

from __future__ import annotations

import argparse
import sys
from collections import Counter

from . import config, scoring, similar
from .output import write_site_data
from .subjects_tag import build_matchers, tag_video
from .util import days_ago, load_json, parse_duration, save_json
from .youtube import Quota, YouTube


# ---------------- resolve ----------------

def _thumb(snippet: dict) -> str:
    t = snippet.get("thumbnails", {})
    for size in ("medium", "high", "default"):
        if size in t:
            return t[size]["url"]
    return ""


def _channel_meta(item: dict, name: str, via: str) -> dict:
    return {
        "channel_id": item["id"],
        "uploads": item["contentDetails"]["relatedPlaylists"]["uploads"],
        "thumb": _thumb(item["snippet"]),
        "name": name,
        "via": via,
    }


def resolve_channels(yt: YouTube, chans: list[dict], ch_cache: dict) -> list[dict]:
    resolved = []
    for c in chans:
        handle = c["handle"]
        meta = ch_cache.get(handle)
        if not meta:
            item = yt.channel_by_handle(handle)
            if item:
                meta = _channel_meta(item, c["name"], "handle")
            else:
                print(f"  ! {handle} did not resolve by handle; searching by name '{c['name']}'")
                hit = yt.search_channel(c["name"])
                if not hit:
                    print(f"  !! could not resolve {c['name']} ({handle}); skipping")
                    continue
                cid = hit["snippet"]["channelId"]
                body = yt._get("channels", {"part": "snippet,contentDetails", "id": cid}, cost=1)
                items = body.get("items") or []
                if not items:
                    print(f"  !! resolved id {cid} for {c['name']} but channels.list was empty; skipping")
                    continue
                meta = _channel_meta(items[0], c["name"], "search")
            ch_cache[handle] = meta
        resolved.append({**c, **meta})
        print(f"  resolved {handle} -> {meta['channel_id']} ({meta.get('via', 'cache')})")
    return resolved


# ---------------- playlist selection ----------------

def _matches(title: str, words: list[str]) -> bool:
    t = title.lower()
    return any(w.lower() in t for w in (words or []))


def select_playlists(yt: YouTube, chan: dict, selection: dict) -> list[dict]:
    """Return kept playlists [{id,title}] for a playlist-mode channel, updating `selection`."""
    kept = []
    chan_sel = selection.setdefault(chan["handle"], {})
    for pl in yt.playlists(chan["channel_id"]):
        pid = pl["id"]
        title = pl["snippet"]["title"]
        if pid in chan_sel:
            rec = chan_sel[pid]
            rec["title"] = title
        else:
            keep = _matches(title, chan.get("include")) and not _matches(title, chan.get("exclude"))
            reason = "include match" if keep else "no include match / excluded"
            rec = {"title": title, "keep": keep, "reason": reason}
            chan_sel[pid] = rec
        if rec["keep"]:
            kept.append({"id": pid, "title": title})
    return kept


# ---------------- collect ----------------

def collect_channel(yt: YouTube, uploads: str, known: set[str]) -> list[str]:
    """Newest-first paging; stop once we hit an already-known id (incremental)."""
    new_ids = []
    for it in yt.playlist_items(uploads):
        vid = it["contentDetails"]["videoId"]
        if vid in known:
            break
        new_ids.append(vid)
    return new_ids


def collect_all_playlists(yt: YouTube, resolved: list[dict], kept_ids: set[str], cache_pl: dict) -> list[dict]:
    """Fetch each channel's playlists (bounded + cached), keep those that hold
    enough of our videos, and return [{id,title,channel_id,thumb,videos,count}]."""
    run_ch = {c["channel_id"] for c in resolved}
    for c in resolved:
        cid = c["channel_id"]
        fetched = 0
        for pl in yt.playlists(cid):
            pid = pl["id"]
            sn = pl.get("snippet", {})
            n = pl.get("contentDetails", {}).get("itemCount", 0)
            if n < config.PLAYLIST_MIN or n > config.PLAYLIST_MAX_ITEMS:
                continue
            cached = cache_pl.get(pid)
            if cached and cached.get("itemCount") == n:
                members = cached["videos"]
            else:
                if fetched >= config.PLAYLIST_CAP_PER_CHANNEL:
                    continue
                members = [it["contentDetails"]["videoId"] for it in yt.playlist_items(pid)]
                fetched += 1
            cache_pl[pid] = {
                "title": sn.get("title", ""), "channel_id": cid,
                "itemCount": n, "thumb": _thumb(sn), "videos": members,
            }
    out = []
    for pid, rec in cache_pl.items():
        if rec["channel_id"] not in run_ch:
            continue
        kept = [vid for vid in rec["videos"] if vid in kept_ids]
        if len(kept) >= config.PLAYLIST_MIN:
            out.append({
                "id": pid, "title": rec["title"], "channel_id": rec["channel_id"],
                "thumb": rec["thumb"], "videos": kept, "count": len(kept),
            })
    out.sort(key=lambda p: p["count"], reverse=True)
    return out


def collect_playlists(yt: YouTube, kept: list[dict]) -> tuple[list[str], dict[str, dict], list[dict]]:
    """Return (all_ids, id->{playlist_id,playlist_title}, courses[])."""
    ids: list[str] = []
    meta: dict[str, dict] = {}
    courses = []
    for pl in kept:
        order = []
        for it in yt.playlist_items(pl["id"]):
            vid = it["contentDetails"]["videoId"]
            order.append(vid)
            ids.append(vid)
            meta.setdefault(vid, {"playlist_id": pl["id"], "playlist_title": pl["title"]})
        courses.append({"playlist_id": pl["id"], "title": pl["title"], "videos": order})
    return ids, meta, courses


# ---------------- filter ----------------

def keep_video(rec: dict) -> bool:
    if rec.get("upcoming") or rec.get("live"):
        return False
    if rec.get("embeddable") is False:   # owner disabled playback on other sites
        return False
    if rec["duration"] <= config.MIN_DURATION_S:
        return False
    title = rec["title"].lower()
    if any(p in title for p in config.JUNK_ALWAYS):
        return False
    if rec["duration"] < config.JUNK_SHORT_S and any(p in title for p in config.JUNK_PATTERNS):
        return False
    return True


# ---------------- details ----------------

def video_record(item: dict, extra: dict) -> dict:
    sn = item.get("snippet", {})
    cd = item.get("contentDetails", {})
    st = item.get("statistics", {})
    status = item.get("status", {})
    live = item.get("liveStreamingDetails", {})
    is_upcoming = sn.get("liveBroadcastContent") == "upcoming" or (
        "scheduledStartTime" in live and "actualEndTime" not in live and "actualStartTime" not in live
    )
    rec = {
        "id": item["id"],
        "channel_id": sn.get("channelId", ""),
        "title": sn.get("title", ""),
        "description": (sn.get("description", "") or "")[:3000],
        "desc_full": True,
        "tags": sn.get("tags", []) or [],
        "published": sn.get("publishedAt", ""),
        "duration": parse_duration(cd.get("duration", "")),
        "views": int(st.get("viewCount", 0) or 0),
        "likes": int(st.get("likeCount", 0) or 0),
        "comments": int(st.get("commentCount", 0) or 0),
        "live": sn.get("liveBroadcastContent") == "live",
        "upcoming": bool(is_upcoming),
        "privacy": status.get("privacyStatus", "public"),
        "embeddable": status.get("embeddable", True),
        "stats_fetched": "",
    }
    rec.update(extra)
    return rec


# ---------------- main ----------------

def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", help="comma-separated handles to build (testing)")
    ap.add_argument("--limit", type=int, default=0, help="cap collected new videos per channel (testing)")
    args = ap.parse_args(argv)

    config.load_dotenv()
    key = config.api_key()
    quota = Quota()
    yt = YouTube(key, quota)

    chans = config.load_channels()
    if args.only:
        wanted = {h.strip().lower() for h in args.only.split(",")}
        chans = [c for c in chans if c["handle"].lower() in wanted or c["handle"].lstrip("@").lower() in wanted]
        print(f"Testing on {len(chans)} channel(s)")

    subjects = config.load_subjects()
    matchers = build_matchers(subjects)

    cache = load_json(config.CACHE_VIDEOS, {})          # id -> record
    ch_cache = load_json(config.CACHE_CHANNELS, {})      # handle -> meta
    selection = load_json(config.PLAYLIST_SELECTION, {})

    print("Resolving channels...")
    resolved = resolve_channels(yt, chans, ch_cache)
    save_json(config.CACHE_CHANNELS, ch_cache)

    known = set(cache.keys())
    to_fetch: list[str] = []
    pl_meta: dict[str, dict] = {}
    all_courses: list[dict] = []

    print("Collecting video ids...")
    for c in resolved:
        if c["mode"] == "playlists":
            kept = select_playlists(yt, c, selection)
            save_json(config.PLAYLIST_SELECTION, selection)
            ids, meta, courses = collect_playlists(yt, kept)
            for cr in courses:
                cr["channel_id"] = c["channel_id"]
            all_courses.extend(courses)
            pl_meta.update(meta)
            new = [i for i in ids if i not in cache]
            print(f"  {c['handle']}: {len(kept)} kept playlists, {len(ids)} videos ({len(new)} new)")
            to_fetch.extend(new)
        else:
            if not c.get("uploads"):
                print(f"  {c['handle']}: no uploads playlist; skipping")
                continue
            new = collect_channel(yt, c["uploads"], known)
            if args.limit:
                new = new[: args.limit]
            print(f"  {c['handle']}: {len(new)} new videos")
            to_fetch.extend(new)

    # stale-stats refresh (rotating slice, capped)
    stale = [
        vid for vid, r in cache.items()
        if r.get("stats_fetched") and days_ago(r["stats_fetched"]) > config.STATS_REFRESH_AFTER_DAYS
    ]
    stale.sort(key=lambda vid: cache[vid].get("stats_fetched", ""))
    stale = stale[: config.STATS_REFRESH_CAP]
    refresh = [v for v in stale if v not in set(to_fetch)]

    # one-time backfill: re-fetch cached videos missing newer fields
    backfill = [
        vid for vid, r in cache.items()
        if r.get("privacy") != "removed" and ("embeddable" not in r or not r.get("desc_full"))
    ]
    if backfill:
        print(f"Backfilling embeddable/description for {len(backfill)} cached videos...")

    fetch_ids = list(dict.fromkeys(to_fetch + refresh + backfill))
    print(f"Fetching details for {len(fetch_ids)} videos ({len(to_fetch)} new, {len(refresh)} stat refresh)...")
    from .util import now
    now_iso = now().isoformat(timespec="seconds")
    if fetch_ids:
        items = yt.videos(fetch_ids)
        got = {it["id"] for it in items}
        for it in items:
            extra = pl_meta.get(it["id"], {})
            rec = video_record(it, extra)
            rec["stats_fetched"] = now_iso
            # preserve playlist info if we already had it
            old = cache.get(it["id"], {})
            if "playlist_title" not in rec and old.get("playlist_title"):
                rec["playlist_title"] = old["playlist_title"]
            cache[it["id"]] = rec
        missing = set(fetch_ids) - got
        for vid in missing:            # deleted/private -> mark so we don't refetch forever
            if vid in cache:
                cache[vid]["privacy"] = "removed"

    save_json(config.CACHE_VIDEOS, cache)

    # build the kept set for THIS run's channels
    run_channel_ids = {c["channel_id"] for c in resolved}
    videos = []
    for r in cache.values():
        if r["channel_id"] not in run_channel_ids:
            continue
        if r.get("privacy") == "removed":
            continue
        if not keep_video(r):
            continue
        # Tag on title + playlist title only. The API 'tags' field is noisy on
        # big generalist channels (MIT OCW etc.) and badly over-matches subjects.
        text = " ".join([r["title"], r.get("playlist_title", "") or ""])
        default = next((c.get("default_subject") for c in resolved if c["channel_id"] == r["channel_id"]), None)
        r = {**r, "subjects": tag_video(text, matchers, default)}
        videos.append(r)

    print(f"Kept {len(videos)} videos after filtering.")
    scoring.score_videos(videos)
    print("Embedding + similarity...")
    vecs = similar.embed(videos)
    neighbours = similar.neighbours(vecs, videos)
    vectors = similar.quantize(vecs)
    vectors["ids"] = [v["id"] for v in videos]

    print("Collecting playlists...")
    cache_pl = load_json(config.CACHE_PLAYLISTS, {})
    kept_ids = {v["id"] for v in videos}
    playlists = collect_all_playlists(yt, resolved, kept_ids, cache_pl)
    save_json(config.CACHE_PLAYLISTS, cache_pl)
    print(f"  {len(playlists)} playlists kept.")

    channels_meta = [
        {"channel_id": c["channel_id"], "name": c["name"], "handle": c["handle"],
         "group": c["group"], "thumb": c.get("thumb", "")}
        for c in resolved
    ]
    meta = write_site_data(videos, channels_meta, subjects, neighbours, all_courses, playlists, vectors)

    # ---- summary ----
    print("\n===== SUMMARY =====")
    per_channel = Counter(v["channel_id"] for v in videos)
    name_by_id = {c["channel_id"]: c["name"] for c in resolved}
    for cid, n in per_channel.most_common():
        print(f"  {n:5d}  {name_by_id.get(cid, cid)}")
    per_subject: Counter = Counter()
    for v in videos:
        for s in v["subjects"]:
            per_subject[s] += 1
    print("  --- per subject ---")
    sname = {s["id"]: s["name"] for s in subjects}
    for sid, n in per_subject.most_common():
        print(f"  {n:5d}  {sname.get(sid, sid)}")
    print(f"  --- longs (>= 60m): {meta['longs']}")
    print(f"  --- data size: {meta['bytes']/1024:.1f} KB across {meta['shards']} similarity shards")
    print(f"  --- quota used (approx): {quota.units} / 10000 units")
    print("===================\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
