// A tiny online learning-to-rank model. It learns, in the browser, how much you
// personally weight a video's intrinsic properties (quality, freshness, being a
// course entry point, popularity, length, mid-series position) from your implicit
// feedback — likes (+), hides (−), and how much of a video you actually watch.
// Logistic regression updated by SGD; weights persist in localStorage.

import type { Video } from "./data";
import { seriesIndex } from "./data";

const KEY = "steel:ranker:v1";
const FEATURES = 6;
const LR = 0.05;
const L2 = 0.001;

// sensible priors so a brand-new user behaves like the hand-tuned ranker
const DEFAULT_W = [0.6, 0.2, 0.25, 0.15, 0.0, 0.3];

interface Model {
  w: number[];
  b: number;
}

function load(): Model {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const m = JSON.parse(raw);
      if (Array.isArray(m.w) && m.w.length === FEATURES) return m;
    }
  } catch {
    /* ignore */
  }
  return { w: [...DEFAULT_W], b: 0 };
}

let model = load();
function save(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(model));
  } catch {
    /* ignore */
  }
}

function ageDays(published: string): number {
  return Math.max(0, (Date.now() - new Date(published).getTime()) / 86400000);
}

// All features are intrinsic to the video, so they're reproducible at both
// ranking time and feedback time (no user profile needed).
export function features(v: Video): number[] {
  const si = seriesIndex(v.title);
  return [
    v.score, // quality (already per-channel normalised)
    Math.exp(-ageDays(v.published) / 730), // freshness, 2y half-life -> (0,1]
    si <= 1 ? 1 : 0, // course entry point / standalone
    Math.min(1, Math.log10(v.views + 10) / 7), // popularity ~[0,1]
    Math.min(1, v.duration / 3600), // long-form preference
    si >= 2 ? -Math.min(si, 20) / 20 : 0, // mid-series position (≤0)
  ];
}

const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);
const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

// Ranking score (higher = better).
export function score(v: Video): number {
  return dot(model.w, features(v)) + model.b;
}

// One SGD step toward a target label in [0,1].
export function learn(v: Video, label: number): void {
  const f = features(v);
  const p = sigmoid(dot(model.w, f) + model.b);
  const err = p - Math.max(0, Math.min(1, label));
  for (let i = 0; i < FEATURES; i++) model.w[i] -= LR * (err * f[i] + L2 * model.w[i]);
  model.b -= LR * err;
  save();
}

// Throttled watch signal: learn from completion only when it grows meaningfully.
const lastCompletion = new Map<string, number>();
export function observe(v: Video, completion: number): void {
  const prev = lastCompletion.get(v.id) ?? 0;
  if (completion - prev < 0.15) return;
  lastCompletion.set(v.id, completion);
  learn(v, completion);
}

export function reset(): void {
  model = { w: [...DEFAULT_W], b: 0 };
  lastCompletion.clear();
  save();
}
