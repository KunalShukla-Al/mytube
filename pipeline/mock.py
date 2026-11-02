"""Generate placeholder site data for local UI testing (no API key needed).

Runs the REAL scoring, subject-tagging, similarity and output code on
fabricated videos, so it validates the whole output path. The real pipeline
overwrites everything this writes.

    python -m pipeline.mock
"""

from __future__ import annotations

import random
from datetime import timedelta

from . import config, scoring, similar
from .output import write_site_data
from .subjects_tag import build_matchers, tag_video
from .util import now

random.seed(7)

# Title fragments per channel group -> trigger real subject tagging.
GROUP_TOPICS = {
    "AI/ML": ["Transformers explained", "Build nanoGPT from scratch", "RAG with LangChain",
              "LoRA fine-tuning tutorial", "Gradient descent intuition", "Attention paper explained",
              "Diffusion models from scratch", "Neural network backpropagation"],
    "Maths": ["Linear algebra essence", "Bayes theorem explained", "Central limit theorem",
              "Hypothesis testing", "Eigenvalues visually", "Probability distributions"],
    "Core CS": ["Dijkstra algorithm DAA", "Theory of computation: finite automata",
                "Dynamic programming", "DBMS normalization and SQL", "TCP/IP and the OSI model",
                "Compiler design: lexical analysis", "Discrete mathematics proofs"],
    "Full Stack": ["React full course", "Node.js REST API", "Full stack MERN project",
                   "CSS flexbox tutorial", "TypeScript crash course"],
    "Software Engineering": ["System design interview", "Clean code and SOLID",
                             "CI/CD and continuous delivery", "Design patterns"],
    "University Courses": ["CS229 machine learning lecture", "Introduction to algorithms 6.006",
                           "Theory of computation lecture", "Linear algebra 18.06"],
    "Image Processing & CV": ["Digital image processing: histogram equalization",
                              "Edge detection and filtering", "Image segmentation",
                              "Computer vision: convolution"],
    "Startups & Talks": ["How to build a startup", "Lessons from founders", "AI startup school talk"],
}


def fake_id(i: int) -> str:
    alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"
    rnd = "".join(random.choice(alphabet) for _ in range(10))
    return f"{i % 10}{rnd}"


def main() -> int:
    chans = config.load_channels()
    subjects = config.load_subjects()
    matchers = build_matchers(subjects)

    channel_meta = []
    videos = []
    vid_i = 0
    for ci, c in enumerate(chans):
        cid = f"MOCKCID{ci:03d}"
        channel_meta.append({
            "channel_id": cid, "name": c["name"], "handle": c["handle"],
            "group": c["group"], "thumb": "",
        })
        topics = GROUP_TOPICS.get(c["group"], ["Lecture"])
        for k in range(6):
            topic = topics[(k + ci) % len(topics)]
            title = f"{topic} — {c['name']} #{k + 1}"
            dur = random.choice([240, 600, 1200, 2400, 3900, 7200])  # some Longs
            published = (now() - timedelta(days=random.randint(5, 2000))).isoformat()
            default = c.get("default_subject")
            subs = tag_video(title, matchers, default)
            videos.append({
                "id": fake_id(vid_i),
                "channel_id": cid,
                "title": title,
                "tags": [],
                "playlist_title": "",
                "description": topic,
                "published": published,
                "duration": dur,
                "views": random.randint(1000, 5_000_000),
                "likes": random.randint(50, 200_000),
                "subjects": subs,
            })
            vid_i += 1

    scoring.score_videos(videos)
    vecs = similar.embed(videos)
    neighbours = similar.neighbours(vecs, videos)
    courses = [{
        "playlist_id": "MOCKPL1", "channel_id": channel_meta[7]["channel_id"],
        "title": "Algorithms (full course)", "videos": [v["id"] for v in videos[42:48]],
    }]
    meta = write_site_data(videos, channel_meta, subjects, neighbours, courses)
    print(f"Mock data written: {meta['videos']} videos, {meta['bytes']/1024:.1f} KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
