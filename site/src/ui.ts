// DOM + formatting helpers and the shared video card.

import { seriesIndex, type Video, type Playlist } from "./data";
import { store } from "./store";
import * as ranker from "./ranker";

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {},
  children: (Node | string)[] = []
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  const { class: cls, ...rest } = props as any;
  if (cls) node.className = cls;
  Object.assign(node, rest);
  for (const c of children) node.append(typeof c === "string" ? document.createTextNode(c) : c);
  return node;
}

export function clear(node: HTMLElement): void {
  node.replaceChildren();
}

export function fmtDuration(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return (h ? `${h}:` : "") + `${mm}:${String(sec).padStart(2, "0")}`;
}

export function fmtViews(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, "") + "K";
  return String(n);
}

export function timeAgo(dateStr: string): string {
  const then = new Date(dateStr).getTime();
  const days = Math.max(0, Math.floor((Date.now() - then) / 86400000));
  if (days < 1) return "today";
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

// Official creator thumbnail (high-res, falling back to hqdefault on 404).
export function thumbUrl(id: string): string {
  return `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`;
}
export function thumbFallback(id: string): string {
  return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
}

export function isVisible(v: Video): boolean {
  if (!v || !v.channel) return false;
  if (v.duration < store.minDuration()) return false;
  if (store.isNotInterested(v.id)) return false;
  if (store.hiddenChannels().includes(v.channel.id)) return false;
  if (v.subjectIds.some((s) => store.hiddenSubjects().includes(s))) return false;
  return true;
}

export interface CardMenuItem {
  label: string;
  run: () => void;
  removesCard?: boolean; // remove the card from view after running (e.g. Hide)
}

let menuCloserAttached = false;
function closeAllMenus(): void {
  document.querySelectorAll(".card-menu.open").forEach((m) => m.classList.remove("open"));
}

// `extra` adds context items (e.g. "Remove from history").
export function videoCard(v: Video, extra: CardMenuItem[] = []): HTMLElement {
  const link = el("a", { class: "card", href: `#/watch/${v.id}` });

  const thumbWrap = el("div", { class: "thumb" });
  const img = el("img", { loading: "lazy", src: thumbUrl(v.id), alt: "" });
  img.addEventListener("error", () => (img.src = thumbFallback(v.id)), { once: true });
  // maxres can return a grey 120x90 placeholder with HTTP 200 (no error fires);
  // detect it by size and drop to hqdefault.
  img.addEventListener("load", () => {
    if (img.naturalWidth > 0 && img.naturalWidth <= 120 && !img.src.includes("hqdefault")) {
      img.src = thumbFallback(v.id);
    }
  });
  thumbWrap.append(img, el("span", { class: "badge" }, [fmtDuration(v.duration)]));
  if (store.isWatched(v.id)) thumbWrap.append(el("span", { class: "watched-bar" }));

  // ⋮ menu
  const menuBtn = el("button", { class: "card-menu-btn", title: "More" }, ["⋮"]);
  const menu = el("div", { class: "card-menu" });

  const addItem = (label: string, run: () => void, opts: { removes?: boolean; relabel?: () => string } = {}) => {
    const b = el("button", { class: "card-menu-item" }, [label]);
    b.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      run();
      menu.classList.remove("open");
      if (opts.removes) link.remove();
      else if (opts.relabel) b.textContent = opts.relabel();
    });
    menu.append(b);
  };

  addItem(
    store.inWatchLater(v.id) ? "Remove from Watch later" : "Add to Watch later",
    () => store.toggleWatchLater(v.id),
    { relabel: () => (store.inWatchLater(v.id) ? "Remove from Watch later" : "Add to Watch later") }
  );
  addItem("Hide this", () => { store.toggleNotInterested(v.id); ranker.learn(v, 0); }, { removes: true });
  for (const it of extra) addItem(it.label, it.run, { removes: it.removesCard });

  menuBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const open = menu.classList.contains("open");
    closeAllMenus();
    if (!open) menu.classList.add("open");
  });
  thumbWrap.append(menuBtn, menu);

  if (!menuCloserAttached) {
    menuCloserAttached = true;
    document.addEventListener("click", closeAllMenus);
  }

  const title = el("div", { class: "title", title: v.title }, [v.title]);
  const meta = el("div", { class: "meta" }, [
    `${v.channel?.name ?? "?"} · ${fmtViews(v.views)} views · ${timeAgo(v.published)}`,
  ]);

  link.append(thumbWrap, title, meta);
  return link;
}

export function grid(videos: Video[], extraFor?: (v: Video) => CardMenuItem[]): HTMLElement {
  const g = el("div", { class: "grid" });
  for (const v of videos) g.append(videoCard(v, extraFor ? extraFor(v) : []));
  return g;
}

// A "continue the course" card: next unwatched part + a progress bar.
export function courseCard(next: Video, watched: number, total: number): HTMLElement {
  const link = el("a", { class: "card", href: `#/watch/${next.id}` });
  const thumbWrap = el("div", { class: "thumb" });
  const img = el("img", { loading: "lazy", src: thumbUrl(next.id), alt: "" });
  img.addEventListener("error", () => (img.src = thumbFallback(next.id)), { once: true });
  img.addEventListener("load", () => {
    if (img.naturalWidth > 0 && img.naturalWidth <= 120 && !img.src.includes("hqdefault")) img.src = thumbFallback(next.id);
  });

  const bar = el("span", { class: "course-progress-bar" });
  bar.style.width = `${Math.round((watched / total) * 100)}%`;
  thumbWrap.append(
    img,
    el("span", { class: "badge" }, [fmtDuration(next.duration)]),
    el("span", { class: "course-pill" }, [`Continue · ${watched}/${total}`]),
    el("span", { class: "course-progress" }, [bar])
  );

  const part = seriesIndex(next.title) || watched + 1;
  const title = el("div", { class: "title", title: next.title }, [next.title]);
  const meta = el("div", { class: "meta" }, [`${next.channel?.name ?? "?"} · next: part ${part}`]);
  link.append(thumbWrap, title, meta);
  return link;
}

export function playlistCard(pl: Playlist): HTMLElement {
  const link = el("a", { class: "card", href: `#/playlist/${pl.id}` });
  const thumbWrap = el("div", { class: "thumb" });
  const firstId = pl.videos[0];
  const img = el("img", { loading: "lazy", src: thumbUrl(firstId), alt: "" });
  img.addEventListener("error", () => (img.src = thumbFallback(firstId)), { once: true });
  img.addEventListener("load", () => {
    if (img.naturalWidth > 0 && img.naturalWidth <= 120 && !img.src.includes("hqdefault")) img.src = thumbFallback(firstId);
  });
  thumbWrap.append(img, el("span", { class: "pl-overlay" }, [`☰ ${pl.count}`]), el("span", { class: "pl-badge" }, ["PLAYLIST"]));
  const title = el("div", { class: "title", title: pl.title }, [pl.title]);
  const meta = el("div", { class: "meta" }, [`${pl.channel.name} · ${pl.count} videos`]);
  link.append(thumbWrap, title, meta);
  return link;
}

export function playlistGrid(pls: Playlist[]): HTMLElement {
  const g = el("div", { class: "grid" });
  for (const p of pls) g.append(playlistCard(p));
  return g;
}

// Endless-scroll grid: renders in chunks as a sentinel nears the viewport.
export function infiniteGrid(
  videos: Video[],
  extraFor?: (v: Video) => CardMenuItem[],
  chunk = 24
): HTMLElement {
  const wrap = el("div", {});
  const g = el("div", { class: "grid" });
  const sentinel = el("div", { class: "scroll-sentinel" });
  wrap.append(g, sentinel);

  let i = 0;
  const renderMore = () => {
    const end = Math.min(i + chunk, videos.length);
    for (; i < end; i++) g.append(videoCard(videos[i], extraFor ? extraFor(videos[i]) : []));
    if (i >= videos.length) {
      obs.disconnect();
      sentinel.remove();
    }
  };
  const obs = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) renderMore();
    },
    { rootMargin: "800px" }
  );
  renderMore();
  obs.observe(sentinel);
  return wrap;
}

export function section(titleText: string, body: HTMLElement): HTMLElement {
  return el("section", {}, [el("h2", {}, [titleText]), body]);
}

export function empty(msg: string): HTMLElement {
  return el("p", { class: "empty" }, [msg]);
}
