// Loads and indexes the static JSON the pipeline produces.

const BASE = import.meta.env.BASE_URL; // "/mytube/"

export interface Channel {
  id: string;
  name: string;
  handle: string;
  group: string;
  thumb: string;
}
export interface Subject {
  id: string;
  name: string;
  section: string; // "Sem 4" | "Sem 5" | "Sem 6" | "Track"
  code?: string; // official SRM course code
}
export interface Course {
  playlist_id: string;
  title: string;
  videos: string[];
  channel_id: string;
}
export interface Playlist {
  id: string;
  title: string;
  channel: Channel;
  thumb: string;
  videos: string[]; // ordered video ids (that we kept)
  count: number;
}
interface RawPlaylist {
  id: string;
  title: string;
  channel_id: string;
  thumb: string;
  videos: string[];
  count: number;
}
export interface Meta {
  updated: string;
  videos: number;
  channels: number;
  subjects: number;
  longs: number;
  shards: number;
  bytes: number;
}

// Compact on-disk shape
interface RawVideo {
  i: string;
  t: string;
  c: number;
  p: string;
  d: number;
  v: number;
  s: number;
  u: number[];
}

export interface Video {
  id: string;
  title: string;
  channel: Channel;
  published: string; // YYYY-MM-DD
  duration: number; // seconds
  views: number;
  score: number;
  subjects: Subject[];
  subjectIds: string[];
}

export interface DB {
  meta: Meta;
  channels: Channel[];
  subjects: Subject[];
  videos: Video[];
  courses: Course[];
  playlists: Playlist[];
  byId: Map<string, Video>;
  channelById: Map<string, Channel>;
  subjectById: Map<string, Subject>;
  playlistById: Map<string, Playlist>;
}

let db: DB | null = null;
let version = ""; // build timestamp, used to cache-bust data files
const simCache = new Map<string, Record<string, string[]>>();

async function getJSON<T>(path: string, opts: { noStore?: boolean } = {}): Promise<T> {
  const url = `${BASE}data/${path}` + (version && !opts.noStore ? `?v=${version}` : "");
  const res = await fetch(url, opts.noStore ? { cache: "no-store" } : {});
  if (!res.ok) throw new Error(`fetch ${path}: ${res.status}`);
  return res.json() as Promise<T>;
}

export async function loadDB(): Promise<DB> {
  if (db) return db;
  // meta always fresh; its timestamp versions every other file so a new weekly
  // build is picked up instead of a stale cached copy.
  const meta = await getJSON<Meta>("meta.json", { noStore: true });
  version = encodeURIComponent(meta.updated);
  const [channels, subjects, rawVideos, courses, rawPlaylists] = await Promise.all([
    getJSON<Channel[]>("channels.json"),
    getJSON<Subject[]>("subjects.json"),
    getJSON<RawVideo[]>("videos.json"),
    getJSON<Course[]>("courses.json").catch(() => [] as Course[]),
    getJSON<RawPlaylist[]>("playlists.json").catch(() => [] as RawPlaylist[]),
  ]);

  const channelById = new Map(channels.map((c) => [c.id, c]));
  const subjectById = new Map(subjects.map((s) => [s.id, s]));

  const videos: Video[] = rawVideos.map((r) => {
    const subs = r.u.map((idx) => subjects[idx]).filter(Boolean);
    return {
      id: r.i,
      title: r.t,
      channel: channels[r.c],
      published: r.p,
      duration: r.d,
      views: r.v,
      score: r.s,
      subjects: subs,
      subjectIds: subs.map((s) => s.id),
    };
  });

  const byId = new Map(videos.map((v) => [v.id, v]));
  const playlists: Playlist[] = rawPlaylists
    .filter((p) => channelById.has(p.channel_id))
    .map((p) => ({
      id: p.id,
      title: p.title,
      channel: channelById.get(p.channel_id)!,
      thumb: p.thumb,
      videos: p.videos.filter((vid) => byId.has(vid)),
      count: p.count,
    }))
    .filter((p) => p.videos.length >= 2);
  const playlistById = new Map(playlists.map((p) => [p.id, p]));

  db = { meta, channels, subjects, videos, courses, playlists, byId, channelById, subjectById, playlistById };
  buildCourses(videos);
  await loadVectors();
  return db;
}

// --- series / course detection (shared) ---

const SERIES_PATS: RegExp[] = [
  /#\s*0*(\d{1,3})\b/,
  /\bpart\s*0*(\d{1,3})\b/,
  /\bepisode\s*0*(\d{1,3})\b/,
  /\bep\.?\s*0*(\d{1,3})\b/,
  /\blecture\s*0*(\d{1,3})\b/,
  /\blec\.?\s*0*(\d{1,3})\b/,
  /\bunit\s*0*(\d{1,3})\b/,
  /\bday\s*0*(\d{1,3})\b/,
  /\bchapter\s*0*(\d{1,3})\b/,
  /\bl-?\s*0*(\d{1,3})\b/,
  /\b(\d{1,2})\.(\d{1,2})\b/,
];

// 0 = standalone, 1 = entry point, N = part N.
export function seriesIndex(title: string): number {
  const t = title.toLowerCase();
  for (const re of SERIES_PATS) {
    const m = t.match(re);
    if (m) return parseInt(m[1], 10);
  }
  return 0;
}

// channel + title prefix before the part number; shared by all parts of a series.
export function seriesKey(v: Video): string | null {
  const parts = v.title
    .toLowerCase()
    .split(/\s*(?:#|part|p\.|lecture|lec\.?|ep\.?|episode|unit|day|chapter)\s*0*\d+/i);
  const prefix = parts[0].trim();
  return parts.length > 1 && prefix.length >= 6 ? v.channel.id + "|" + prefix : null;
}

let courseIndex = new Map<string, Video[]>();

function buildCourses(videos: Video[]): void {
  const m = new Map<string, Video[]>();
  for (const v of videos) {
    const k = seriesKey(v);
    if (!k) continue;
    (m.get(k) ?? m.set(k, []).get(k)!).push(v);
  }
  for (const [k, arr] of m) {
    if (arr.length < 2) m.delete(k);
    else arr.sort((a, b) => seriesIndex(a.title) - seriesIndex(b.title));
  }
  courseIndex = m;
}

export function courseParts(key: string): Video[] | undefined {
  return courseIndex.get(key);
}
export function courseOf(v: Video): { key: string; parts: Video[]; pos: number } | null {
  const key = seriesKey(v);
  const parts = key ? courseIndex.get(key) : undefined;
  if (!key || !parts) return null;
  return { key, parts, pos: parts.findIndex((p) => p.id === v.id) };
}
export function allCourses(): Video[][] {
  return [...courseIndex.values()];
}

function shardKey(id: string): string {
  const c = (id[0] || "_").toLowerCase();
  return /[a-z0-9]/.test(c) ? c : "_";
}

// Precomputed "up next" neighbour ids for a video (loads one shard lazily).
export async function similarIds(id: string): Promise<string[]> {
  const key = shardKey(id);
  let shard = simCache.get(key);
  if (!shard) {
    try {
      shard = await getJSON<Record<string, string[]>>(`similar/${key}.json`);
    } catch {
      shard = {};
    }
    simCache.set(key, shard);
  }
  return shard[id] || [];
}

// --- compact semantic vectors (for user-vector ranking, MMR, dedup) ---
let vecDim = 0;
const vecById = new Map<string, Float32Array>();
let vecLoaded = false;

export async function loadVectors(): Promise<boolean> {
  if (vecLoaded) return vecById.size > 0;
  vecLoaded = true;
  try {
    const raw = await getJSON<{ dim: number; scale: number; data: string; ids: string[] }>("vectors.json");
    vecDim = raw.dim;
    const bin = atob(raw.data);
    for (let i = 0; i < raw.ids.length; i++) {
      const arr = new Float32Array(raw.dim);
      let norm = 0;
      for (let d = 0; d < raw.dim; d++) {
        const byte = bin.charCodeAt(i * raw.dim + d);
        const val = (byte < 128 ? byte : byte - 256) * raw.scale;
        arr[d] = val;
        norm += val * val;
      }
      norm = Math.sqrt(norm) || 1;
      for (let d = 0; d < raw.dim; d++) arr[d] /= norm;
      vecById.set(raw.ids[i], arr);
    }
  } catch {
    /* vectors are optional */
  }
  return vecById.size > 0;
}

export function vectorOf(id: string): Float32Array | undefined {
  return vecById.get(id);
}
// Both vectors are unit-norm, so the dot product is the cosine similarity.
export function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
// Normalised mean of several vectors -> a "taste" vector.
export function meanVector(ids: string[], weights?: number[]): Float32Array | null {
  if (!vecDim) return null;
  const acc = new Float32Array(vecDim);
  let any = false;
  ids.forEach((id, i) => {
    const v = vecById.get(id);
    if (!v) return;
    any = true;
    const w = weights ? weights[i] : 1;
    for (let d = 0; d < vecDim; d++) acc[d] += v[d] * w;
  });
  if (!any) return null;
  let norm = 0;
  for (let d = 0; d < vecDim; d++) norm += acc[d] * acc[d];
  norm = Math.sqrt(norm) || 1;
  for (let d = 0; d < vecDim; d++) acc[d] /= norm;
  return acc;
}

const descCache = new Map<string, Record<string, string>>();

// Full video description (loads one shard lazily; "" if unavailable).
export async function description(id: string): Promise<string> {
  const key = shardKey(id);
  let shard = descCache.get(key);
  if (!shard) {
    try {
      shard = await getJSON<Record<string, string>>(`desc/${key}.json`);
    } catch {
      shard = {};
    }
    descCache.set(key, shard);
  }
  return shard[id] || "";
}
