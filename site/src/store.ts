// All personal state lives in localStorage. Every access is guarded so the
// site still works in private mode or when storage is blocked.

const KEY = "mytube:v1";

interface HistoryEntry {
  id: string;
  ts: number; // last watched (ms)
  pos: number; // resume seconds
}

interface State {
  likes: string[];
  watchLater: string[];
  notInterested: string[];
  hiddenChannels: string[];
  starredChannels: string[];
  hiddenSubjects: string[];
  history: HistoryEntry[];
  minDuration: number; // seconds
  playbackRate: number;
  autoplay: boolean;
  notes: Record<string, { t: number; text: string }[]>;
}

const EMPTY: State = {
  likes: [],
  watchLater: [],
  notInterested: [],
  hiddenChannels: [],
  starredChannels: [],
  hiddenSubjects: [],
  history: [],
  minDuration: 0,
  playbackRate: 1,
  autoplay: true,
  notes: {},
};

function read(): State {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...EMPTY };
    return { ...EMPTY, ...JSON.parse(raw) };
  } catch {
    return { ...EMPTY };
  }
}

function write(s: State): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore: private mode / quota */
  }
}

let state = read();

const listeners = new Set<() => void>();
export function onChange(fn: () => void): void {
  listeners.add(fn);
}
function changed(): void {
  write(state);
  listeners.forEach((fn) => fn());
}

function toggleIn(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [id, ...list];
}

export const store = {
  // likes
  isLiked: (id: string) => state.likes.includes(id),
  toggleLike(id: string) {
    state.likes = toggleIn(state.likes, id);
    changed();
  },
  likes: () => state.likes,

  // watch later
  inWatchLater: (id: string) => state.watchLater.includes(id),
  toggleWatchLater(id: string) {
    state.watchLater = toggleIn(state.watchLater, id);
    changed();
  },
  watchLater: () => state.watchLater,

  // not interested
  isNotInterested: (id: string) => state.notInterested.includes(id),
  toggleNotInterested(id: string) {
    state.notInterested = toggleIn(state.notInterested, id);
    changed();
  },
  notInterested: () => state.notInterested,

  // history / watched / resume
  isWatched: (id: string) => state.history.some((h) => h.id === id),
  markWatched(id: string, pos = 0) {
    const rest = state.history.filter((h) => h.id !== id);
    state.history = [{ id, ts: Date.now(), pos }, ...rest].slice(0, 2000);
    changed();
  },
  saveResume(id: string, pos: number) {
    const h = state.history.find((x) => x.id === id);
    if (h) {
      h.pos = pos;
      h.ts = Date.now();
      changed();
    } else {
      this.markWatched(id, pos);
    }
  },
  resume: (id: string) => state.history.find((h) => h.id === id)?.pos || 0,
  history: () => state.history,
  removeHistory(id: string) {
    state.history = state.history.filter((h) => h.id !== id);
    changed();
  },
  clearHistory() {
    state.history = [];
    changed();
  },

  // hide channels / subjects
  hiddenChannels: () => state.hiddenChannels,
  toggleChannel(id: string) {
    state.hiddenChannels = toggleIn(state.hiddenChannels, id);
    changed();
  },

  // starred channels: boosted in the home feed
  isStarred: (id: string) => state.starredChannels.includes(id),
  starredChannels: () => state.starredChannels,
  toggleStar(id: string) {
    state.starredChannels = toggleIn(state.starredChannels, id);
    changed();
  },
  hiddenSubjects: () => state.hiddenSubjects,
  toggleSubject(id: string) {
    state.hiddenSubjects = toggleIn(state.hiddenSubjects, id);
    changed();
  },

  // min duration
  minDuration: () => state.minDuration,
  setMinDuration(s: number) {
    state.minDuration = s;
    changed();
  },

  // preferred playback speed (carried across videos)
  playbackRate: () => state.playbackRate || 1,
  setPlaybackRate(r: number) {
    state.playbackRate = r;
    changed();
  },

  // autoplay the next part of a series when a video ends
  autoplay: () => state.autoplay !== false,
  setAutoplay(on: boolean) {
    state.autoplay = on;
    changed();
  },

  // timestamped notes per video
  notesFor: (id: string) => state.notes[id] || [],
  addNote(id: string, t: number, text: string) {
    const arr = state.notes[id] || [];
    arr.push({ t, text });
    arr.sort((a, b) => a.t - b.t);
    state.notes[id] = arr;
    changed();
  },
  removeNote(id: string, i: number) {
    const arr = state.notes[id];
    if (!arr) return;
    arr.splice(i, 1);
    if (!arr.length) delete state.notes[id];
    changed();
  },
  allNotes: () => state.notes,

  // export / import
  exportJSON: () => JSON.stringify(state, null, 2),
  importJSON(text: string) {
    const parsed = JSON.parse(text);
    state = { ...EMPTY, ...parsed };
    changed();
  },
  reset() {
    state = { ...EMPTY };
    changed();
  },
};
