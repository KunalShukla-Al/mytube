import "./styles.css";
import { loadDB } from "./data";
import { buildIndex } from "./search";
import { startRouter } from "./router";
import { el } from "./ui";

// route, label, icon
type NavItem = [string, string, string];

const ICON = {
  menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/></svg>',
  coursework: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5a2 2 0 0 1 2-2h12v18H6a2 2 0 0 1-2-2z"/><path d="M8 3v18"/></svg>',
  track: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="7" width="10" height="10" rx="2"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M4 4l2 2M18 18l2 2"/></svg>',
  playlists: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="7" x2="16" y2="7"/><line x1="4" y1="12" x2="16" y2="12"/><line x1="4" y1="17" x2="12" y2="17"/><path d="M17 11l5 3-5 3z"/></svg>',
  channels: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
  watchlater: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  history: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 4v4h4"/><path d="M12 8v4l3 2"/></svg>',
  dashboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="20" x2="5" y2="11"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="19" y1="20" x2="19" y2="14"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 13.5a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.2a1.6 1.6 0 0 0-2.7-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H2a2 2 0 1 1 0-4h.2a1.6 1.6 0 0 0 1.1-2.7l-.1-.1A2 2 0 1 1 6 4.6l.1.1a1.6 1.6 0 0 0 1.8.3 1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.2a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8 1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.2a1.6 1.6 0 0 0-1.4 1z"/></svg>',
};

const NAV_MAIN: NavItem[] = [
  ["home", "Home", ICON.home],
  ["coursework", "Coursework", ICON.coursework],
  ["track", "AI/ML Track", ICON.track],
  ["playlists", "Playlists", ICON.playlists],
];
const NAV_YOU: NavItem[] = [
  ["dashboard", "Your learning", ICON.dashboard],
  ["channels", "Channels", ICON.channels],
  ["watchlater", "Watch later", ICON.watchlater],
  ["history", "History", ICON.history],
  ["settings", "Settings", ICON.settings],
];

function navLink([route, label, icon]: NavItem): HTMLElement {
  const a = el("a", { href: `#/${route === "home" ? "" : route}`, class: "side-link" });
  a.dataset.route = route;
  const ic = el("span", { class: "side-ic" });
  ic.innerHTML = icon;
  a.append(ic, el("span", { class: "side-label" }, [label]));
  return a;
}

function buildSidebar(): { aside: HTMLElement; backdrop: HTMLElement; toggle: () => void } {
  const aside = el("nav", { class: "sidebar" });
  for (const item of NAV_MAIN) aside.append(navLink(item));
  aside.append(el("div", { class: "side-sep" }));
  aside.append(el("div", { class: "side-head" }, ["You"]));
  for (const item of NAV_YOU) aside.append(navLink(item));

  const backdrop = el("div", { class: "backdrop" });
  const close = () => {
    aside.classList.remove("open");
    backdrop.classList.remove("show");
  };
  const toggle = () => {
    const open = aside.classList.toggle("open");
    backdrop.classList.toggle("show", open);
  };
  backdrop.addEventListener("click", close);
  aside.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest(".side-link")) close();
  });
  return { aside, backdrop, toggle };
}

function header(toggleSidebar: () => void): HTMLElement {
  const menuBtn = el("button", { class: "icon-btn", title: "Menu" });
  menuBtn.innerHTML = ICON.menu;
  menuBtn.addEventListener("click", toggleSidebar);

  const brand = el("a", { class: "brand", href: "#/" }, ["STE", el("span", { class: "accent" }, ["EL"])]);

  const searchInput = el("input", {
    class: "search",
    type: "search",
    placeholder: "Search…",
    value: decodeURIComponent(location.hash.startsWith("#/search/") ? location.hash.slice(9) : ""),
  });
  const searchBox = el("div", { class: "search-box" }, [searchInput]);
  const searchBtn = el("button", { class: "icon-btn", title: "Search" });
  searchBtn.innerHTML = ICON.search;

  if (location.hash.startsWith("#/search/")) searchBox.classList.add("open");
  searchBtn.addEventListener("click", () => {
    searchBox.classList.toggle("open");
    if (searchBox.classList.contains("open")) searchInput.focus();
  });
  searchInput.addEventListener("blur", () => {
    if (!searchInput.value.trim()) searchBox.classList.remove("open");
  });

  let t: number | undefined;
  const go = (replace: boolean) => {
    const q = searchInput.value.trim();
    const target = q ? `#/search/${encodeURIComponent(q)}` : "#/";
    if (replace) location.replace(target);
    else location.hash = target;
  };
  searchInput.addEventListener("input", () => {
    clearTimeout(t);
    t = window.setTimeout(() => go(true), 250);
  });
  searchInput.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") go(false);
  });

  const top = el("div", { class: "top" }, [menuBtn, brand, el("div", { class: "grow" }), searchBox, searchBtn]);
  return el("header", { class: "site-header" }, [top]);
}

async function main() {
  const app = document.getElementById("app")!;
  const { aside, backdrop, toggle } = buildSidebar();
  app.append(header(toggle), aside, backdrop);
  const view = el("main", { class: "view" });
  app.append(view);

  try {
    const db = await loadDB();
    buildIndex(db.videos);
    startRouter(db, view);
  } catch (e) {
    view.append(
      el("div", { class: "page" }, [
        el("h1", {}, ["Data not built yet"]),
        el("p", {}, [
          "The video data hasn't been generated. Run the pipeline (see pipeline/README.md) to create site/public/data, then reload.",
        ]),
        el("p", { class: "empty" }, [(e as Error).message]),
      ])
    );
  }
}

main();
