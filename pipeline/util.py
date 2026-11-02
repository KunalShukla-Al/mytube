"""Small helpers: cache I/O, duration/date parsing."""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path

_DUR = re.compile(
    r"P(?:(?P<days>\d+)D)?T(?:(?P<h>\d+)H)?(?:(?P<m>\d+)M)?(?:(?P<s>\d+)S)?"
)


def parse_duration(iso: str) -> int:
    """ISO-8601 duration (e.g. 'PT1H2M3S') -> seconds. Returns 0 if unparseable."""
    if not iso:
        return 0
    m = _DUR.fullmatch(iso)
    if not m:
        return 0
    d = m.groupdict()
    days = int(d["days"] or 0)
    return days * 86400 + int(d["h"] or 0) * 3600 + int(d["m"] or 0) * 60 + int(d["s"] or 0)


def parse_date(iso: str) -> datetime:
    return datetime.fromisoformat(iso.replace("Z", "+00:00"))


def now() -> datetime:
    return datetime.now(timezone.utc)


def days_ago(iso: str) -> float:
    try:
        return (now() - parse_date(iso)).total_seconds() / 86400.0
    except Exception:  # noqa: BLE001
        return 0.0


def load_json(path: Path, default):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return default


def save_json(path: Path, obj, *, minify: bool = False) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    if minify:
        text = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
    else:
        text = json.dumps(obj, ensure_ascii=False, indent=2)
    path.write_text(text, encoding="utf-8")
    return len(text.encode("utf-8"))
