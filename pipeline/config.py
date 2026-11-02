"""Paths, settings, and config loading."""

from __future__ import annotations

import os
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
CONFIG_DIR = ROOT / "config"
DATA_DIR = ROOT / "data"
CACHE_DIR = DATA_DIR / "cache"
OUT_DIR = ROOT / "site" / "public" / "data"

CACHE_VIDEOS = CACHE_DIR / "videos.json"
CACHE_CHANNELS = CACHE_DIR / "channels.json"
CACHE_PLAYLISTS = CACHE_DIR / "playlists.json"
PLAYLIST_SELECTION = CONFIG_DIR / "playlist_selection.json"

# Playlist collection (for the "playlists as items" feature)
PLAYLIST_MIN = 3        # keep playlists with at least this many of our videos
PLAYLIST_MAX_ITEMS = 80 # skip giant dumps
PLAYLIST_CAP_PER_CHANNEL = 40

# Filtering
MIN_DURATION_S = 180            # drop anything <= 3 minutes (Shorts, clips)
LONG_DURATION_S = 60 * 60       # "Longs" threshold: 60 minutes
JUNK_SHORT_S = 5 * 60           # junk-title rule only applies under 5 minutes

# Scoring weights
W_QUALITY = 0.5
W_POPULARITY = 0.3
W_FRESHNESS = 0.2
FRESHNESS_HALF_LIFE_DAYS = 365 * 2   # slow decay: 2-year half-life

# Similarity
TOP_SIMILAR = 20
SAME_SUBJECT_BOOST = 0.08
SAME_CHANNEL_PENALTY = 0.10

# Incremental stats refresh: re-fetch stats for videos not updated in this long,
# capped per run so we stay under quota.
STATS_REFRESH_AFTER_DAYS = 7
STATS_REFRESH_CAP = 1500        # <= 30 videos.list calls

# Junk title patterns (lowercased substring match), only enforced under JUNK_SHORT_S
JUNK_PATTERNS = ["#shorts", "live stream", "trailer"]

# Non-educational titles dropped at ANY length (vlogs, channel-admin, hype).
JUNK_ALWAYS = [
    "thank you", "subscribers", "unboxing", "play button", "giveaway",
    "vlog", "q&a", "day in the life", "guidelines buy", "promotion and exam",
    "celebrating", "channel update", "road to ", "announcement", "my story",
    "ask me anything", "live stream", "livestream", "live chat", "my struggles",
    "up close", "are a lie",
]


def load_yaml(path: Path) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


def load_channels() -> list[dict]:
    return load_yaml(CONFIG_DIR / "channels.yaml")["channels"]


def load_subjects() -> list[dict]:
    return load_yaml(CONFIG_DIR / "subjects.yaml")["subjects"]


def api_key() -> str:
    key = os.environ.get("YOUTUBE_API_KEY", "").strip()
    if not key:
        raise SystemExit(
            "YOUTUBE_API_KEY is not set. Put it in a local .env (see .env.example) "
            "or as a GitHub Actions secret."
        )
    return key


def load_dotenv() -> None:
    """Minimal .env loader (no dependency). Does not override existing env vars."""
    env = ROOT / ".env"
    if not env.exists():
        return
    for line in env.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip())
