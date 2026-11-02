# MyTube

A quiet, distraction-free YouTube feed built only from channels I trust — no
recommendation algorithm, no logins, no engagement feed. Inspired by
[hackertube.org](https://hackertube.org), but the videos come from my hand-picked
channel list, organised around my coursework (Sem 4 onward) and deep AI/ML.

- **Static site** on GitHub Pages — no server, no database.
- **Free**: YouTube Data API free tier + GitHub Actions + GitHub Pages.
- **Self-updating** every Sunday via a scheduled Action.
- Likes, history and watch-later live in your browser (localStorage).
- Honest thumbnails: a frame from the middle of each video, not the clickbait one.

Live site: `https://kunalshukla-al.github.io/mytube/`

## Structure

```
config/        channels.yaml, subjects.yaml, playlist_selection.json (editable)
pipeline/      Python: pull from YouTube API -> filter, score, tag, relate -> JSON
site/          Vite + vanilla TypeScript static site
data/cache/    committed video cache (keeps weekly runs incremental & cheap)
.github/       build + deploy workflow
```

## Quick start

```bash
# 1. Data (needs a YouTube Data API v3 key in .env — see .env.example)
python -m venv .venv && source .venv/bin/activate
pip install -r pipeline/requirements.txt
python -m pipeline.build

# 2. Site
cd site && npm install && npm run dev      # http://localhost:5173/mytube/
```

To preview the UI before you have a key: `python -m pipeline.mock` writes
placeholder data, then run the site.

## Editing the feed

- Add/remove channels: edit `config/channels.yaml`.
- Change subject tagging: edit `config/subjects.yaml`.
- Override playlist picks for Dr. E. Suresh / Jenny's Lectures: edit `keep` flags
  in `config/playlist_selection.json`.

See `pipeline/README.md` for how the data pipeline works.
