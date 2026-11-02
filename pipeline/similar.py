"""Precompute 'Up next' neighbours for every video.

Default: TF-IDF -> LSA (TruncatedSVD) -> L2-normalised dense vectors, then a
chunked top-k cosine search (scales to tens of thousands of videos on CPU).
Optional: sentence-transformers embeddings if USE_EMBEDDINGS=1 and installed.
"""

from __future__ import annotations

import os

import numpy as np

from . import config


def _text(v: dict) -> str:
    parts = [
        v.get("title", ""),
        " ".join(v.get("tags", []) or []),
        v.get("playlist_title", "") or "",
        (v.get("description", "") or "")[:300],
    ]
    return " ".join(parts)


def _embed_tfidf(texts: list[str]) -> np.ndarray:
    from sklearn.decomposition import TruncatedSVD
    from sklearn.feature_extraction.text import TfidfVectorizer
    from sklearn.preprocessing import normalize

    vec = TfidfVectorizer(
        stop_words="english",
        ngram_range=(1, 2),
        max_features=40000,
        sublinear_tf=True,
        min_df=2,
    )
    X = vec.fit_transform(texts)
    n_features = X.shape[1]
    dims = min(200, n_features - 1, max(2, len(texts) - 1))
    if len(texts) > 300 and dims >= 2:
        svd = TruncatedSVD(n_components=dims, random_state=0)
        X = svd.fit_transform(X)
    else:
        X = X.toarray()
    return normalize(X.astype(np.float32))


def _embed_fastembed(texts: list[str]) -> np.ndarray:
    """Semantic sentence embeddings via fastembed (ONNX, no PyTorch)."""
    from fastembed import TextEmbedding
    from sklearn.preprocessing import normalize

    model = TextEmbedding("BAAI/bge-small-en-v1.5")
    emb = np.array(list(model.embed(texts, batch_size=256)), dtype=np.float32)
    return normalize(emb)


def embed(videos: list[dict]) -> np.ndarray:
    """L2-normalised embedding matrix for the videos (semantic, or TF-IDF fallback)."""
    texts = [_text(v) for v in videos]
    if os.environ.get("USE_TFIDF") == "1":
        print("  embeddings: TF-IDF + LSA")
        return _embed_tfidf(texts)
    try:
        v = _embed_fastembed(texts)
        print("  embeddings: bge-small semantic")
        return v
    except Exception as e:  # noqa: BLE001
        print(f"  embeddings: unavailable ({e}); using TF-IDF")
        return _embed_tfidf(texts)


def quantize(vecs: np.ndarray, dim: int = 48) -> dict:
    """Reduce (PCA) and int8-quantize vectors for the browser. Returns
    {dim, scale, data(base64)} in the same row order as `vecs`."""
    import base64

    from sklearn.decomposition import TruncatedSVD

    n = vecs.shape[0]
    d = min(dim, vecs.shape[1])
    if n > d and d >= 2:
        red = TruncatedSVD(n_components=d, random_state=0).fit_transform(vecs)
    else:
        red = vecs[:, :d]
    scale = float(np.abs(red).max()) / 127.0 or 1.0
    q = np.clip(np.round(red / scale), -127, 127).astype(np.int8)
    return {"dim": d, "scale": scale, "data": base64.b64encode(q.tobytes()).decode("ascii")}


def neighbours(vecs: np.ndarray, videos: list[dict]) -> dict[str, list[str]]:
    n = len(videos)
    if n == 0:
        return {}
    ids = [v["id"] for v in videos]
    channels = np.array([v["channel_id"] for v in videos])
    subjects = [set(v.get("subjects", [])) for v in videos]

    k = config.TOP_SIMILAR
    pool = min(n - 1, k * 3 + 10)   # re-rank a slightly larger candidate pool
    out: dict[str, list[str]] = {}

    chunk = 512
    for start in range(0, n, chunk):
        end = min(start + chunk, n)
        sims = vecs[start:end] @ vecs.T          # (rows, n)
        for r in range(end - start):
            i = start + r
            row = sims[r]
            row[i] = -1.0                         # exclude self
            cand = np.argpartition(row, -pool)[-pool:]
            # re-rank candidates with diversity boosts/penalties
            scored = []
            si = subjects[i]
            ci = channels[i]
            for j in cand:
                s = float(row[j])
                if subjects[j] & si:
                    s += config.SAME_SUBJECT_BOOST
                if channels[j] == ci:
                    s -= config.SAME_CHANNEL_PENALTY
                scored.append((s, j))
            scored.sort(reverse=True)
            out[ids[i]] = [ids[j] for _, j in scored[:k]]
    return out
