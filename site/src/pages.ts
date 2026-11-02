// Page renderers. Each returns an HTMLElement (some are async).

import type { DB, Video } from "./data";
import { similarIds, description, courseOf, allCourses, vectorOf, cosine, meanVector } from "./data";
import { store } from "./store";
import { search } from "./search";
import * as ranker from "./ranker";
import {
  clear,
  courseCard,
  el,
  empty,
  fmtDuration,
  fmtViews,
  grid,
  infiniteGrid,
  isVisible,
  playlistGrid,
  section,
  timeAgo,
  videoCard,
} from "./ui";
import type { CardMenuItem } from "./ui";

// --- playlist queue (autoplay through a playlist, survives reload) ---
function setQueue(ids: string[]): void {
  try { sessionStorage.setItem("steel:queue", JSON.stringify(ids)); } catch { /* ignore */ }
}
function getQueue(): string[] {
  try { return JSON.parse(sessionStorage.getItem("steel:queue") || "[]"); } catch { return []; }
}
function queueNext(id: string): string | null {
  const q = getQueue();
  const i = q.indexOf(id);
  return i >= 0 && i + 1 < q.length ? q[i + 1] : null;
}

const YT_ICON =
  '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path fill="#ff3b30" d="M23 7.5a3 3 0 0 0-2.1-2.1C19 5 12 5 12 5s-7 0-8.9.4A3 3 0 0 0 1 7.5 31 31 0 0 0 .6 12 31 31 0 0 0 1 16.5a3 3 0 0 0 2.1 2.1C5 19 12 19 12 19s7 0 8.9-.4A3 3 0 0 0 23 16.5 31 31 0 0 0 23.4 12 31 31 0 0 0 23 7.5z"/><path fill="#fff" d="M9.8 15.3V8.7l5.7 3.3z"/></svg>';

function visibleVideos(db: DB): Video[] {
  return db.videos.filter(isVisible);
}

// Turn URLs in a description into clickable links (text nodes stay as text).
function linkify(text: string): Node[] {
  const nodes: Node[] = [];
  const re = /(https?:\/\/[^\s<]+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push(document.createTextNode(text.slice(last, m.index)));
    nodes.push(el("a", { class: "desc-link", href: m[0], target: "_blank", rel: "noopener" }, [m[0]]));
    last = m.index + m[0].length;
  }
  if (last < text.length) nodes.push(document.createTextNode(text.slice(last)));
  return nodes;
}

// Parse "0:00 Title" style chapter timestamps from a description.
function parseChapters(text: string): { t: number; label: string }[] {
  const out: { t: number; label: string }[] = [];
  const re = /(?:^|\n)\s*\(?(\d{1,2}:\d{2}(?::\d{2})?)\)?\s*[-–—:)]*\s*([^\n]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const p = m[1].split(":").map(Number);
    const t = p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
    const label = m[2].trim().replace(/^[-–—:)\s]+/, "").slice(0, 90);
    if (label.length > 1) out.push({ t, label });
  }
  return out.length >= 3 ? out.slice(0, 80) : [];
}

// Timestamped notes panel for a video (stored locally).
function buildNotes(id: string): HTMLElement {
  const box = el("section", { class: "notes" }, [el("h2", { class: "desc-h" }, ["Notes"])]);
  const list = el("div", { class: "note-list" });
  const render = () => {
    clear(list);
    const notes = store.notesFor(id);
    if (!notes.length) {
      list.append(el("p", { class: "empty" }, ["No notes yet — add one at the current timestamp."]));
      return;
    }
    notes.forEach((nt, i) => {
      const t = el("button", { class: "note-t" }, [fmtDuration(nt.t)]);
      t.addEventListener("click", () => playerSeek(nt.t));
      const x = el("button", { class: "note-x", title: "Delete" }, ["✕"]);
      x.addEventListener("click", () => { store.removeNote(id, i); render(); });
      list.append(el("div", { class: "note" }, [t, el("span", { class: "note-text" }, [nt.text]), x]));
    });
  };
  const input = el("input", { class: "input note-input", type: "text", placeholder: "Add a note…" });
  const addBtn = el("button", { class: "btn tiny" }, ["+ Note @ time"]);
  const add = () => {
    const text = input.value.trim();
    if (!text) return;
    store.addNote(id, playerTime(), text);
    input.value = "";
    render();
  };
  addBtn.addEventListener("click", add);
  input.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") add(); });
  box.append(el("div", { class: "note-add" }, [input, addBtn]), list);
  render();
  return box;
}

// ---------------- Home / For you ----------------

// Home feed = intrinsic quality + a SMALL topic-affinity nudge, then a hard
// per-channel cap so no single channel can dominate. Affinity is by subject and
// by precomputed-neighbour votes (both topic signals), never by channel — so
// watching one Suresh video nudges you toward Probability broadly, not toward
// more Suresh.
const AFFINITY_WEIGHT = 0.4; // deliberately small: personalises "a very little"
const STAR_WEIGHT = 0.5;     // boost for videos from channels you've starred
const USER_VEC_WEIGHT = 0.8; // semantic closeness to your taste vector
const MMR_LAMBDA = 0.5;      // diversity vs relevance in MMR selection
const DEDUP_SIM = 0.93;      // collapse near-identical videos above this cosine

// Maximal Marginal Relevance: greedily pick high-rank, low-redundancy videos
// using the semantic vectors, with a soft per-channel cap and dedup.
function mmrSelect(pool: { v: Video; rank: number }[], count: number, chCap: number): Video[] {
  const sel: Video[] = [];
  const selVecs: Float32Array[] = [];
  const perCh = new Map<string, number>();
  const remaining = pool.slice();
  while (sel.length < count && remaining.length) {
    let bestI = -1;
    let best = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const { v, rank } = remaining[i];
      if ((perCh.get(v.channel.id) || 0) >= chCap) continue;
      const vec = vectorOf(v.id);
      let maxSim = 0;
      if (vec) for (const sv of selVecs) maxSim = Math.max(maxSim, cosine(vec, sv));
      if (maxSim > DEDUP_SIM) continue;
      const mmr = rank - MMR_LAMBDA * maxSim;
      if (mmr > best) {
        best = mmr;
        bestI = i;
      }
    }
    if (bestI < 0) break;
    const [chosen] = remaining.splice(bestI, 1);
    sel.push(chosen.v);
    const cv = vectorOf(chosen.v.id);
    if (cv) selVecs.push(cv);
    perCh.set(chosen.v.channel.id, (perCh.get(chosen.v.channel.id) || 0) + 1);
  }
  return sel;
}

// Drop near-identical videos (same lecture across channels, re-uploads).
function vecDedup(videos: Video[], threshold = 0.95): Video[] {
  const out: Video[] = [];
  const vecs: Float32Array[] = [];
  for (const v of videos) {
    const vec = vectorOf(v.id);
    if (vec) {
      let dup = false;
      for (const s of vecs) if (cosine(vec, s) > threshold) { dup = true; break; }
      if (dup) continue;
      vecs.push(vec);
    }
    out.push(v);
  }
  return out;
}

// The immediate next part of v's course (P6 -> P7), via the shared course index.
function nextInSeries(v: Video): Video | null {
  const c = courseOf(v);
  if (!c || c.pos < 0 || c.pos + 1 >= c.parts.length) return null;
  const p = c.parts[c.pos + 1];
  return isVisible(p) && !store.isWatched(p.id) ? p : null;
}

function dedupe(videos: Video[]): Video[] {
  const seen = new Set<string>();
  return videos.filter((v) => (seen.has(v.id) ? false : (seen.add(v.id), true)));
}

function capPerChannel(videos: Video[], cap: number): Video[] {
  const per = new Map<string, number>();
  const out: Video[] = [];
  for (const v of videos) {
    const n = per.get(v.channel.id) || 0;
    if (n >= cap) continue;
    per.set(v.channel.id, n + 1);
    out.push(v);
  }
  return out;
}
function clip(s: string, n = 42): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// Netflix/YouTube-inspired: a two-stage recommender (candidate generation ->
// ranking) laid out as recency-weighted rows, with diversity caps + light
// exploration so the feed stays varied and fresh on each visit.
export async function renderHome(db: DB): Promise<HTMLElement> {
  const root = el("div", { class: "page" });
  const history = store.history(); // most recent first
  const likes = store.likes();
  const watched = new Set(history.map((h) => h.id));

  // recency-weighted taste profile (recent watches outweigh old ones)
  const subjWeight = new Map<string, number>();
  const seeds: { id: string; w: number }[] = [];
  history.forEach((h, i) => {
    const w = 1 / (1 + i * 0.35);
    seeds.push({ id: h.id, w });
    db.byId.get(h.id)?.subjectIds.forEach((s) => subjWeight.set(s, (subjWeight.get(s) || 0) + w));
  });
  likes.forEach((id) => {
    seeds.push({ id, w: 1.3 });
    db.byId.get(id)?.subjectIds.forEach((s) => subjWeight.set(s, (subjWeight.get(s) || 0) + 1.3));
  });
  let maxSubj = 0;
  subjWeight.forEach((w) => (maxSubj = Math.max(maxSubj, w)));

  // candidate generation: neighbour votes from weighted seeds
  const votes = new Map<string, number>();
  const topSeeds = seeds.sort((a, b) => b.w - a.w).slice(0, 24);
  const lists = await Promise.all(topSeeds.map((s) => similarIds(s.id)));
  lists.forEach((l, i) => {
    const w = topSeeds[i].w;
    for (const nid of l) votes.set(nid, (votes.get(nid) || 0) + w);
  });
  let maxVote = 0;
  votes.forEach((w) => (maxVote = Math.max(maxVote, w)));

  const vis = visibleVideos(db);
  const used = new Set<string>();

  // Row: Continue learning (course progress — the next unwatched part of a
  // course you've started, newest first)
  const histPos = new Map(history.map((h, i) => [h.id, i])); // 0 = most recent
  const inProgress: { next: Video; watched: number; total: number; recency: number }[] = [];
  for (const parts of allCourses()) {
    let watchedCount = 0;
    let maxWatchedPos = -1;
    let recency = Infinity;
    parts.forEach((p, i) => {
      if (store.isWatched(p.id)) {
        watchedCount++;
        maxWatchedPos = Math.max(maxWatchedPos, i);
        const r = histPos.get(p.id);
        if (r !== undefined) recency = Math.min(recency, r);
      }
    });
    if (watchedCount < 1 || watchedCount >= parts.length) continue;
    const next =
      parts.slice(maxWatchedPos + 1).find((p) => !store.isWatched(p.id) && isVisible(p)) ||
      parts.find((p) => !store.isWatched(p.id) && isVisible(p));
    if (next && !used.has(next.id)) inProgress.push({ next, watched: watchedCount, total: parts.length, recency });
  }
  inProgress.sort((a, b) => a.recency - b.recency);
  const continueCourses = inProgress.slice(0, 8);
  if (continueCourses.length) {
    const g = el("div", { class: "grid" });
    continueCourses.forEach((c) => {
      used.add(c.next.id);
      g.append(courseCard(c.next, c.watched, c.total));
    });
    root.append(section("Continue learning", g));
  }

  // Row: Continue watching (resumes in progress)
  const cont = history
    .map((h) => ({ h, v: db.byId.get(h.id) }))
    .filter((x): x is { h: HistoryLike; v: Video } =>
      !!x.v && isVisible(x.v) && x.h.pos > 25 && x.h.pos < x.v.duration - 45)
    .map((x) => x.v)
    .slice(0, 12);
  if (cont.length) {
    cont.forEach((v) => used.add(v.id));
    root.append(section("Continue watching", grid(cont)));
  }

  // Row: Because you watched <most recent> (its next series part comes first)
  const recent = history.map((h) => db.byId.get(h.id)).find((v): v is Video => !!v && isVisible(v));
  if (recent) {
    const nbrs = await similarIds(recent.id);
    const nxt = nextInSeries(recent);
    const neigh = nbrs
      .map((id) => db.byId.get(id))
      .filter((x): x is Video => !!x && isVisible(x) && !watched.has(x.id) && !used.has(x.id));
    const rec = dedupe([...(nxt ? [nxt] : []), ...capPerChannel(neigh, 1)]).slice(0, 12);
    if (rec.length) {
      rec.forEach((v) => used.add(v.id));
      root.append(section(`Because you watched ${clip(recent.title)}`, grid(rec)));
    }
  }

  // Your "taste vector": the recency-weighted mean of what you've watched/liked
  const userVec = meanVector(topSeeds.map((s) => s.id), topSeeds.map((s) => s.w));

  // Main feed: ranker + topic affinity + star + semantic closeness to your taste
  const ranked = vis
    .filter((v) => v.subjectIds.length > 0 && !watched.has(v.id) && !used.has(v.id))
    .map((v) => {
      let aff = 0;
      if (maxSubj > 0) {
        const sm = v.subjectIds.reduce((a, s) => a + (subjWeight.get(s) || 0), 0);
        aff += 0.6 * Math.min(1, sm / maxSubj);
      }
      if (maxVote > 0) aff += 0.4 * ((votes.get(v.id) || 0) / maxVote);
      const explore = Math.random() * 0.3;
      const star = store.isStarred(v.channel.id) ? STAR_WEIGHT : 0;
      let userSim = 0;
      if (userVec) {
        const vec = vectorOf(v.id);
        if (vec) userSim = cosine(vec, userVec);
      }
      return { v, rank: ranker.score(v) + AFFINITY_WEIGHT * aff + star + USER_VEC_WEIGHT * userSim + explore };
    })
    .sort((a, b) => b.rank - a.rank);

  // MMR picks a diverse, de-duplicated top; a capped tail keeps the scroll endless.
  const top = mmrSelect(ranked.slice(0, 300), 48, 3);
  const topIds = new Set(top.map((v) => v.id));
  const tail = capPerChannel(ranked.map((r) => r.v).filter((v) => !topIds.has(v.id)), 4);
  const feedList = dedupe([...top, ...tail]).slice(0, 400);
  root.append(section("For you", feedList.length ? infiniteGrid(feedList) : empty("No videos yet.")));

  return root;
}

interface HistoryLike { id: string; ts: number; pos: number; }

// ---------------- Coursework ----------------

// One course = one subject. Show the official name + code, then split its
// videos by channel so each source is its own block.
function courseBlock(db: DB, subj: { id: string; name: string; code?: string }): HTMLElement | null {
  const vids = visibleVideos(db)
    .filter((v) => v.subjectIds.includes(subj.id))
    .sort((a, b) => b.score - a.score);
  if (!vids.length) return null;

  const head = el("div", { class: "course-head" }, [
    el("h2", { class: "course-name" }, [subj.name]),
  ]);
  if (subj.code) head.append(el("span", { class: "course-code" }, [subj.code]));
  head.append(el("span", { class: "course-total" }, [`${vids.length} videos`]));

  const block = el("section", { class: "course-block", id: `course-${subj.id}` }, [head]);

  // group by channel, channels with the most first
  const byChannel = new Map<string, Video[]>();
  for (const v of vids) {
    const list = byChannel.get(v.channel.id) ?? [];
    list.push(v);
    byChannel.set(v.channel.id, list);
  }
  const ordered = [...byChannel.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [cid, cvids] of ordered) {
    const ch = db.channelById.get(cid);
    const row = el("div", { class: "chan-row" }, [
      el("div", { class: "chan-row-head" }, [
        el("a", { class: "chan-row-name", href: `#/channel/${cid}` }, [ch?.name ?? "?"]),
        el("span", { class: "chan-row-count" }, [`${cvids.length}`]),
      ]),
      grid(cvids.slice(0, 8)),
    ]);
    block.append(row);
  }
  return block;
}

export function renderCoursework(db: DB): HTMLElement {
  const root = el("div", { class: "page" });
  root.append(el("h1", {}, ["Coursework"]));
  const sems = ["Sem 4", "Sem 5", "Sem 6"];
  const body = el("div", {});
  const tabs = el("div", { class: "tabs" });
  const quicknav = el("div", { class: "quicknav" });

  const draw = (sem: string) => {
    clear(body);
    clear(quicknav);
    for (const subj of db.subjects.filter((s) => s.section === sem)) {
      const block = courseBlock(db, subj);
      if (!block) continue;
      body.append(block);
      // quick-jump chip to this course
      const chip = el("button", { class: "qchip" }, [
        subj.name,
        subj.code ? el("span", { class: "qchip-code" }, [subj.code]) : "",
      ]);
      chip.addEventListener("click", () =>
        document.getElementById(`course-${subj.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" })
      );
      quicknav.append(chip);
    }
    if (!body.children.length) body.append(empty("No videos tagged for this semester yet."));
  };

  sems.forEach((sem, i) => {
    const btn = el("button", { class: "tab" + (i === 0 ? " active" : "") }, [sem]);
    btn.addEventListener("click", () => {
      tabs.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      btn.classList.add("active");
      draw(sem);
    });
    tabs.append(btn);
  });
  root.append(tabs, quicknav, body);
  draw("Sem 4");
  return root;
}

// ---------------- AI/ML Track ----------------

// Ordered from the basics at the top to the hardest, most frontier material
// at the bottom.
const TRACK_ORDER: [string, string][] = [
  ["maths_for_ml", "Start here — the maths underneath"],
  ["ml_foundations", "Core ML & deep-learning foundations"],
  ["ml_intuition", "Build the intuition"],
  ["ml_from_scratch", "Implement it from scratch"],
  ["applied_genai", "Applied — RAG, LoRA, fine-tuning, agents"],
  ["computer_vision", "Computer vision"],
  ["papers", "Frontier — read the papers"],
];

export function renderTrack(db: DB): HTMLElement {
  const root = el("div", { class: "page track" });
  root.append(
    el("h1", {}, ["Deep AI / ML Track"]),
    el("p", { class: "lede" }, ["Top to bottom: start at the basics, and it gets harder as you go down."])
  );
  const visible = visibleVideos(db);
  let stage = 0;
  for (const [sid, label] of TRACK_ORDER) {
    const subj = db.subjectById.get(sid);
    const all = visible.filter((v) => v.subjectIds.includes(sid)).sort((a, b) => b.score - a.score);
    if (!subj || !all.length) continue;
    stage += 1;
    root.append(
      el("section", { class: "stage" }, [
        el("div", { class: "stage-head" }, [
          el("span", { class: "stage-num" }, [String(stage)]),
          el("div", { class: "stage-text" }, [
            el("h2", { class: "stage-title" }, [subj.name, el("span", { class: "count-pill" }, [String(all.length)])]),
            el("p", { class: "stage-label" }, [label]),
          ]),
        ]),
        grid(all.slice(0, 18)),
      ])
    );
  }
  if (!root.querySelector(".stage")) root.append(empty("No track videos yet."));
  return root;
}

// ---------------- Channels ----------------

export function renderChannels(db: DB): HTMLElement {
  const root = el("div", { class: "page" });
  root.append(el("h1", {}, ["Channels"]));
  const counts = new Map<string, number>();
  for (const v of db.videos) counts.set(v.channel.id, (counts.get(v.channel.id) || 0) + 1);
  const groups = [...new Set(db.channels.map((c) => c.group))];
  for (const g of groups) {
    const list = el("div", { class: "chan-grid" });
    for (const c of db.channels.filter((ch) => ch.group === g)) {
      const star = el("button", { class: "chan-star" + (store.isStarred(c.id) ? " on" : ""), title: "Star channel" }, [
        store.isStarred(c.id) ? "★" : "☆",
      ]);
      star.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        store.toggleStar(c.id);
        star.className = "chan-star" + (store.isStarred(c.id) ? " on" : "");
        star.textContent = store.isStarred(c.id) ? "★" : "☆";
      });
      const a = el("a", { class: "chan", href: `#/channel/${c.id}` }, [
        el("img", { class: "chan-thumb", loading: "lazy", src: c.thumb, alt: "" }),
        el("span", { class: "chan-name" }, [c.name]),
        el("span", { class: "chan-count" }, [`${counts.get(c.id) || 0} videos`]),
        star,
      ]);
      list.append(a);
    }
    root.append(section(g, list));
  }
  return root;
}

export function renderChannel(db: DB, id: string): HTMLElement {
  const root = el("div", { class: "page" });
  const ch = db.channelById.get(id);
  if (!ch) return root.appendChild(empty("Channel not found.")), root;
  const starBtn = el("button", { class: "btn" + (store.isStarred(id) ? " on" : "") }, [store.isStarred(id) ? "★ Starred" : "☆ Star channel"]);
  starBtn.addEventListener("click", () => {
    store.toggleStar(id);
    starBtn.className = "btn" + (store.isStarred(id) ? " on" : "");
    starBtn.textContent = store.isStarred(id) ? "★ Starred" : "☆ Star channel";
  });
  root.append(
    el("div", { class: "chan-head" }, [
      el("img", { class: "chan-thumb big", src: ch.thumb, alt: "" }),
      el("div", {}, [
        el("h1", {}, [ch.name]),
        el("p", { class: "lede" }, [`${ch.handle} · ${ch.group}`]),
        starBtn,
      ]),
    ])
  );
  const vids = db.videos.filter((v) => v.channel.id === id && isVisible(v)).sort((a, b) => b.score - a.score);
  const courses = db.courses.filter((c) => c.channel_id === id && c.videos.length > 1);
  if (courses.length) {
    const list = el("div", { class: "courses" });
    for (const c of courses) {
      list.append(
        el("a", { class: "course", href: `#/watch/${c.videos[0]}` }, [
          el("span", { class: "course-title" }, [c.title]),
          el("span", { class: "course-meta" }, [`${c.videos.length} videos`]),
        ])
      );
    }
    root.append(section("Courses", list));
  }
  root.append(section(`Videos (${vids.length})`, vids.length ? grid(vids) : empty("No videos.")));
  return root;
}

// ---------------- Playlist ----------------

export function renderPlaylist(db: DB, id: string): HTMLElement {
  const root = el("div", { class: "page" });
  const pl = db.playlistById.get(id);
  if (!pl) return root.appendChild(empty("Playlist not found.")), root;

  const vids = pl.videos.map((vid) => db.byId.get(vid)).filter((v): v is Video => !!v);
  const playAll = el("button", { class: "btn" }, ["▶ Play all"]);
  playAll.addEventListener("click", () => {
    setQueue(pl.videos);
    if (pl.videos[0]) location.hash = `#/watch/${pl.videos[0]}`;
  });
  root.append(
    el("div", { class: "chan-head" }, [
      el("div", {}, [
        el("h1", {}, [pl.title]),
        el("p", { class: "lede" }, [
          el("a", { class: "chip", href: `#/channel/${pl.channel.id}` }, [pl.channel.name]),
          ` · ${pl.count} videos · playlist`,
        ]),
        playAll,
      ]),
    ])
  );
  const g = el("div", { class: "grid" });
  for (const v of vids) {
    const card = videoCard(v);
    card.addEventListener("click", () => setQueue(pl.videos));
    g.append(card);
  }
  root.append(g);
  return root;
}

// ---------------- Playlists library ----------------

export function renderPlaylists(db: DB): HTMLElement {
  const root = el("div", { class: "page" });
  root.append(
    el("h1", {}, ["Playlists & courses"]),
    el("p", { class: "lede" }, [`${db.playlists.length} playlists from your trusted channels.`])
  );
  if (!db.playlists.length) return root.append(empty("No playlists yet.")), root;
  for (const gname of [...new Set(db.channels.map((c) => c.group))]) {
    const pls = db.playlists.filter((p) => p.channel.group === gname).sort((a, b) => b.count - a.count);
    if (pls.length) root.append(section(gname, playlistGrid(pls)));
  }
  return root;
}

// ---------------- Watch ----------------

export async function renderWatch(db: DB, id: string): Promise<HTMLElement> {
  const root = el("div", { class: "page watch" });
  const v = db.byId.get(id);
  if (!v) return root.appendChild(empty("Video not found.")), root;

  const resume = store.resume(id);
  const playerWrap = el("div", { class: "player theatre" });
  const iframe = el("iframe", {
    id: "yt-player",
    allow: "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share",
    allowFullscreen: true,
    src: `https://www.youtube-nocookie.com/embed/${id}?rel=0&autoplay=1&playsinline=1&vq=hd1080&enablejsapi=1${resume ? `&start=${resume}` : ""}`,
  });
  playerWrap.append(iframe);

  const title = el("h1", { class: "watch-title" }, [v.title]);

  // Like + YouTube link, on the LEFT of the meta row
  const likeBtn = el("button", { class: "btn tiny" + (store.isLiked(id) ? " on" : "") }, [store.isLiked(id) ? "♥ Liked" : "♡ Like"]);
  likeBtn.addEventListener("click", () => {
    store.toggleLike(id);
    if (store.isLiked(id)) ranker.learn(v, 1);
    likeBtn.className = "btn tiny" + (store.isLiked(id) ? " on" : "");
    likeBtn.textContent = store.isLiked(id) ? "♥ Liked" : "♡ Like";
  });
  const ytLink = el("a", { class: "yt-btn", href: `https://www.youtube.com/watch?v=${id}`, target: "_blank", rel: "noopener", title: "Open on YouTube" });
  ytLink.innerHTML = YT_ICON;

  const meta = el("div", { class: "watch-meta" }, [
    el("span", { class: "watch-actions" }, [likeBtn, ytLink]),
    el("a", { class: "chip", href: `#/channel/${v.channel.id}` }, [v.channel.name]),
    el("span", { class: "muted" }, [`${fmtViews(v.views)} views · ${timeAgo(v.published)} · ${fmtDuration(v.duration)}`]),
  ]);
  for (const s of v.subjects) meta.append(el("a", { class: "tag", href: `#/coursework` }, [s.name]));

  const info = el("div", { class: "watch-info" }, [title, meta]);

  // Chapters (from description) + Description + Notes
  const chaptersBox = el("div", { class: "chapters" });
  const descBox = el("div", { class: "desc" });
  info.append(chaptersBox, descBox, buildNotes(id));
  void description(id).then((text) => {
    const chapters = parseChapters(text);
    if (chapters.length) {
      const clist = el("div", { class: "chapter-list" });
      for (const c of chapters) {
        const b = el("button", { class: "chapter" }, [
          el("span", { class: "chapter-t" }, [fmtDuration(c.t)]),
          el("span", { class: "chapter-l" }, [c.label]),
        ]);
        b.addEventListener("click", () => playerSeek(c.t));
        clist.append(b);
      }
      chaptersBox.append(el("h2", { class: "desc-h" }, ["Chapters"]), clist);
    }
    if (text.trim()) {
      const body = el("div", { class: "desc-body collapsed" });
      linkify(text).forEach((n) => body.append(n));
      const toggle = el("button", { class: "desc-toggle" }, ["Show more"]);
      toggle.addEventListener("click", () => {
        const collapsed = body.classList.toggle("collapsed");
        toggle.textContent = collapsed ? "Show more" : "Show less";
      });
      descBox.append(el("h2", { class: "desc-h" }, ["Description"]), body, toggle);
    }
  });

  const nbrs = await similarIds(id);
  const nxt = nextInSeries(v);
  const neigh = nbrs
    .map((nid) => db.byId.get(nid))
    .filter((x): x is Video => !!x && isVisible(x) && !store.isWatched(x.id) && x.id !== id);
  // endless continuation from the same subjects, best first
  const subjSet = new Set(v.subjectIds);
  const more = visibleVideos(db)
    .filter((x) => x.id !== id && !store.isWatched(x.id) && x.subjectIds.some((s) => subjSet.has(s)))
    .sort((a, b) => b.score - a.score);
  const upList = vecDedup(dedupe([...(nxt ? [nxt] : []), ...neigh, ...more])).slice(0, 250);
  const upWrap = el("section", { class: "up-next-theatre" }, [el("h2", {}, ["Up next"])]);
  upWrap.append(upList.length ? infiniteGrid(upList) : empty("No suggestions."));

  root.append(playerWrap, info, upWrap);

  store.markWatched(id, resume);
  // autoplay: next in the active playlist queue, else the first Up-next video
  const autoNext = queueNext(id) ?? upList[0]?.id ?? null;
  setupPlayer(id, v, autoNext);
  return root;
}

// IFrame Player API: highest quality, resume tracking, watch-signal for the
// ranker, autoplay next, and seek control for chapters/notes.
let ytPlayer: any = null;
function playerSeek(t: number): void {
  try { ytPlayer?.seekTo?.(t, true); ytPlayer?.playVideo?.(); } catch { /* ignore */ }
}
function playerTime(): number {
  try { return Math.floor(ytPlayer?.getCurrentTime?.() || 0); } catch { return 0; }
}
function setupPlayer(id: string, v: Video, nextId: string | null): void {
  const w = window as any;
  const start = () => {
    if (!w.YT || !w.YT.Player) return;
    try {
      ytPlayer = new w.YT.Player("yt-player", {
        events: {
          onReady: (e: any) => {
            const p = e.target;
            try { p.setPlaybackQuality("hd1080"); } catch { /* ignore */ } // best-effort; YT auto-selects
            setInterval(() => {
              try {
                const t = Math.floor(p.getCurrentTime?.() || 0);
                if (t > 0) {
                  store.saveResume(id, t);
                  if (v.duration) ranker.observe(v, t / v.duration);
                }
              } catch {
                /* ignore */
              }
            }, 5000);
          },
          onStateChange: (e: any) => {
            if (e.data === 0) {
              // ENDED -> strong positive signal + autoplay next course part
              ranker.learn(v, 1);
              if (nextId && store.autoplay()) location.hash = `#/watch/${nextId}`;
            }
          },
        },
      });
    } catch {
      /* ignore */
    }
  };
  if (w.YT && w.YT.Player) {
    start();
  } else if (!w.__ytApiLoading) {
    w.__ytApiLoading = true;
    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    w.onYouTubeIframeAPIReady = () => {
      w.__ytReady = true;
      start();
    };
    document.head.append(tag);
  } else {
    const iv = setInterval(() => {
      if (w.YT && w.YT.Player) {
        clearInterval(iv);
        start();
      }
    }, 300);
    setTimeout(() => clearInterval(iv), 8000);
  }
}

// ---------------- Library pages ----------------

function listPage(
  db: DB,
  titleText: string,
  ids: string[],
  note?: string,
  extraFor?: (v: Video) => CardMenuItem[]
): HTMLElement {
  const root = el("div", { class: "page" });
  root.append(el("h1", {}, [titleText]));
  if (note) root.append(el("p", { class: "lede" }, [note]));
  const vids = ids.map((id) => db.byId.get(id)).filter((v): v is Video => !!v);
  root.append(vids.length ? grid(vids, extraFor) : empty("Nothing here yet."));
  return root;
}

export const renderWatchLater = (db: DB) => listPage(db, "Watch later", store.watchLater());
export function renderHistory(db: DB): HTMLElement {
  return listPage(db, "History", store.history().map((h) => h.id), "Most recent first.", (v) => [
    { label: "Remove from history", run: () => store.removeHistory(v.id), removesCard: true },
  ]);
}

// ---------------- Dashboard ----------------

function dayStr(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
function statTile(num: string, label: string): HTMLElement {
  return el("div", { class: "stat-tile" }, [
    el("div", { class: "stat-num" }, [num]),
    el("div", { class: "stat-label" }, [label]),
  ]);
}
function progRow(name: string, w: number, total: number): HTMLElement {
  const bar = el("span", { class: "prog-bar" });
  bar.style.width = `${Math.round((w / total) * 100)}%`;
  return el("div", { class: "prog-row" }, [
    el("div", { class: "prog-head" }, [el("span", {}, [name]), el("span", { class: "prog-count" }, [`${w}/${total}`])]),
    el("div", { class: "prog-track" }, [bar]),
  ]);
}

export function renderDashboard(db: DB): HTMLElement {
  const root = el("div", { class: "page" });
  root.append(el("h1", {}, ["Your learning"]));
  const history = store.history();

  // daily streak (consecutive days with a watch, ending today or yesterday)
  const days = new Set(history.map((h) => dayStr(h.ts)));
  let streak = 0;
  if (days.has(dayStr(Date.now())) || days.has(dayStr(Date.now() - 86400000))) {
    let cur = days.has(dayStr(Date.now())) ? Date.now() : Date.now() - 86400000;
    while (days.has(dayStr(cur))) {
      streak++;
      cur -= 86400000;
    }
  }

  const watched = history.map((h) => ({ h, v: db.byId.get(h.id) })).filter((x) => !!x.v);
  const seconds = watched.reduce((s, { h, v }) => s + (h.pos > 30 ? Math.min(h.pos, v!.duration) : v!.duration), 0);
  const hours = seconds / 3600;
  let inProgress = 0;
  for (const parts of allCourses()) {
    const w = parts.filter((p) => store.isWatched(p.id)).length;
    if (w >= 1 && w < parts.length) inProgress++;
  }
  const notesCount = Object.values(store.allNotes()).reduce((s, a) => s + a.length, 0);

  root.append(
    el("div", { class: "stat-grid" }, [
      statTile(String(streak), "day streak"),
      statTile(String(watched.length), "videos watched"),
      statTile(hours >= 10 ? String(Math.round(hours)) : hours.toFixed(1), "hours (approx)"),
      statTile(String(inProgress), "courses in progress"),
      statTile(String(store.likes().length), "liked"),
      statTile(String(notesCount), "notes"),
    ])
  );

  const watchedIds = new Set(history.map((h) => h.id));
  const bars = el("div", { class: "prog-list" });
  for (const subj of db.subjects) {
    const vids = db.videos.filter((v) => v.subjectIds.includes(subj.id) && isVisible(v));
    const w = vids.filter((v) => watchedIds.has(v.id)).length;
    if (w > 0) bars.append(progRow(subj.name, w, vids.length));
  }
  root.append(
    el("section", {}, [
      el("h2", {}, ["Progress by subject"]),
      bars.children.length ? bars : empty("Watch some videos to see progress."),
    ])
  );
  return root;
}

// ---------------- Search ----------------

export function renderSearch(db: DB, q: string): HTMLElement {
  const root = el("div", { class: "page" });
  root.append(el("h1", {}, [q ? `Search: ${q}` : "Search"]));
  if (!q) return root.append(empty("Type in the search box above.")), root;
  const ql = q.toLowerCase();
  const pls = db.playlists
    .filter((p) => p.title.toLowerCase().includes(ql) || p.channel.name.toLowerCase().includes(ql))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
  if (pls.length) root.append(section("Playlists", playlistGrid(pls)));
  const results = search(q).filter(isVisible);
  root.append(results.length ? section("Videos", grid(results)) : empty(`No results for “${q}”.`));
  return root;
}

// ---------------- Settings ----------------

export function renderSettings(db: DB): HTMLElement {
  const root = el("div", { class: "page" });
  root.append(el("h1", {}, ["Settings"]));

  // min duration
  const durSel = el("select", { class: "input" });
  for (const [label, val] of [["No minimum", "0"], ["≥ 3 min", "180"], ["≥ 5 min", "300"], ["≥ 20 min", "1200"], ["≥ 60 min", "3600"]] as [string, string][]) {
    const o = el("option", { value: val }, [label]);
    if (Number(val) === store.minDuration()) o.selected = true;
    durSel.append(o);
  }
  durSel.addEventListener("change", () => store.setMinDuration(Number(durSel.value)));
  root.append(section("Minimum video length", durSel));

  // autoplay next course part
  const autoWrap = el("div", { class: "check-grid" }, [
    toggleRow("Autoplay the next part of a course when a video ends", store.autoplay(), () =>
      store.setAutoplay(!store.autoplay())
    ),
  ]);
  root.append(section("Autoplay", autoWrap));

  // hide subjects
  const subBox = el("div", { class: "check-grid" });
  for (const s of db.subjects) {
    subBox.append(toggleRow(s.name, store.hiddenSubjects().includes(s.id), () => store.toggleSubject(s.id)));
  }
  root.append(section("Hide subjects", subBox));

  // hide channels
  const chBox = el("div", { class: "check-grid" });
  for (const c of db.channels) {
    chBox.append(toggleRow(c.name, store.hiddenChannels().includes(c.id), () => store.toggleChannel(c.id)));
  }
  root.append(section("Hide channels", chBox));

  // not interested
  const niIds = store.notInterested();
  if (niIds.length) {
    const list = el("div", { class: "check-grid" });
    for (const id of niIds) {
      const v = db.byId.get(id);
      const row = el("label", { class: "check" }, [
        el("span", {}, [v?.title ?? id]),
        (() => {
          const b = el("button", { class: "btn tiny" }, ["Unhide"]);
          b.addEventListener("click", () => {
            store.toggleNotInterested(id);
            row.remove();
          });
          return b;
        })(),
      ]);
      list.append(row);
    }
    root.append(section("Not interested (hidden from feeds)", list));
  }

  // data
  const dataRow = el("div", { class: "actions" });
  const exportBtn = el("button", { class: "btn" }, ["Export my data"]);
  exportBtn.addEventListener("click", () => {
    const blob = new Blob([store.exportJSON()], { type: "application/json" });
    const a = el("a", { href: URL.createObjectURL(blob), download: "mytube-data.json" });
    a.click();
    URL.revokeObjectURL(a.href);
  });
  const importInput = el("input", { type: "file", accept: "application/json", class: "hidden-file" });
  const importBtn = el("button", { class: "btn" }, ["Import data"]);
  importBtn.addEventListener("click", () => importInput.click());
  importInput.addEventListener("change", async () => {
    const f = importInput.files?.[0];
    if (!f) return;
    try {
      store.importJSON(await f.text());
      alert("Imported.");
      location.reload();
    } catch {
      alert("Could not read that file.");
    }
  });
  const clearBtn = el("button", { class: "btn" }, ["Clear history"]);
  clearBtn.addEventListener("click", () => {
    if (confirm("Clear watch history?")) store.clearHistory();
  });
  const relearnBtn = el("button", { class: "btn" }, ["Reset learned recommendations"]);
  relearnBtn.addEventListener("click", () => {
    if (confirm("Reset the recommendation model back to defaults?")) ranker.reset();
  });
  const resetBtn = el("button", { class: "btn danger" }, ["Reset everything"]);
  resetBtn.addEventListener("click", () => {
    if (confirm("Erase all likes, history and settings on this device?")) store.reset();
  });
  dataRow.append(exportBtn, importBtn, importInput, clearBtn, relearnBtn, resetBtn);
  root.append(section("Your data", dataRow));
  return root;
}

function toggleRow(label: string, checked: boolean, onToggle: () => void): HTMLElement {
  const input = el("input", { type: "checkbox", checked });
  input.addEventListener("change", onToggle);
  return el("label", { class: "check" }, [input, el("span", {}, [label])]);
}

