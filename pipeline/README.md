# MyTube pipeline

Pulls videos from a trusted channel list (YouTube Data API v3), filters,
scores, tags by subject, computes "up next" neighbours, and writes compact
JSON to `site/public/data/`.

## Run locally

```bash
cd mytube
python -m venv .venv && source .venv/bin/activate
pip install -r pipeline/requirements.txt
cp .env.example .env            # then paste your YOUTUBE_API_KEY
python -m pipeline.build
```

Useful flags for testing:

```bash
python -m pipeline.build --only @3blue1brown,@abdul_bari,@dresuresh   # a few channels
python -m pipeline.build --only @mitocw --limit 100                    # cap new videos
```

## What it does

1. **Resolve** each channel handle to a channel id + uploads playlist (`channels.list`). Falls back to search by name and logs the choice.
2. **Collect** video ids: whole-channel mode pages the uploads playlist (stopping at the first already-known id, so later runs are incremental); playlist mode pages only the selected playlists.
3. **Fetch details** (`videos.list`, 50 at a time) for new ids, plus a capped rotating slice of stale stats (older than 7 days).
4. **Filter** out Shorts (≤3 min), upcoming/live, removed videos, and junk-titled short clips.
5. **Score** per channel: `0.5·quality + 0.3·popularity + 0.2·freshness`, where quality and popularity are z-scored within each channel so big channels don't dominate.
6. **Tag** subjects via keyword rules in `config/subjects.yaml` (+ a channel's default subject).
7. **Similarity**: TF-IDF → LSA → chunked top-k cosine, with a same-subject boost and same-channel penalty for diverse "up next" lists. Set `USE_EMBEDDINGS=1` to use `sentence-transformers` instead (if installed).
8. **Write** `videos.json`, `channels.json`, `subjects.json`, `courses.json`, `similar/{shard}.json`, `meta.json` (all minified).

## Caches (committed, so Actions runs stay incremental and cheap)

- `data/cache/videos.json` — every fetched video (kept or not), with last stats-fetch time.
- `data/cache/channels.json` — resolved channel ids/uploads/thumbnails by handle.
- `config/playlist_selection.json` — for playlist-mode channels (Dr. E. Suresh, Jenny's Lectures): each playlist with `keep` + reason. Edit `keep` to override; later runs respect your choice and only auto-classify new playlists.

## Quota

Daily free budget is 10,000 units. The build prints approximate units used. A full first run across ~39 channels is a few thousand units; incremental runs are far less.
