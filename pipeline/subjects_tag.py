"""Tag videos with subjects using keyword rules from subjects.yaml."""

from __future__ import annotations

import re


def _compile(keywords: list[str]) -> list[re.Pattern]:
    pats = []
    for kw in keywords:
        kw = kw.strip().lower()
        if not kw:
            continue
        # custom boundaries: treat [a-z0-9] as word chars so short tokens
        # like "api", "sql", "dfa" don't match inside other words.
        pats.append(re.compile(r"(?<![a-z0-9])" + re.escape(kw) + r"(?![a-z0-9])"))
    return pats


def build_matchers(subjects: list[dict]) -> dict[str, list[re.Pattern]]:
    return {s["id"]: _compile(s.get("keywords", [])) for s in subjects}


def tag_video(text: str, matchers: dict[str, list[re.Pattern]], default: str | None) -> list[str]:
    text = text.lower()
    hits: list[str] = []
    for sid, pats in matchers.items():
        if any(p.search(text) for p in pats):
            hits.append(sid)
    if default and default not in hits:
        hits.append(default)
    return hits
