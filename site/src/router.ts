// Tiny hash router. GitHub Pages needs no server rewrites with hash routes.

import type { DB } from "./data";
import { clear, el } from "./ui";
import * as pages from "./pages";

interface Route {
  name: string;
  param: string;
}

function parse(): Route {
  const raw = location.hash.replace(/^#\/?/, "");
  const [name, ...rest] = raw.split("/");
  return { name: name || "home", param: decodeURIComponent(rest.join("/")) };
}

export function startRouter(db: DB, view: HTMLElement): void {
  async function render() {
    const { name, param } = parse();
    clear(view);
    view.append(el("div", { class: "loading" }, ["…"]));
    try {
      const node = await dispatch(db, name, param);
      clear(view);
      view.append(node);
      // highlight active nav link
      document.querySelectorAll("[data-route]").forEach((a) => {
        a.classList.toggle("active", (a as HTMLElement).dataset.route === name);
      });
      window.scrollTo(0, 0);
    } catch (e) {
      clear(view);
      view.append(el("p", { class: "empty" }, [`Something went wrong: ${(e as Error).message}`]));
    }
  }
  window.addEventListener("hashchange", render);
  render();
}

async function dispatch(db: DB, name: string, param: string): Promise<HTMLElement> {
  switch (name) {
    case "home":
      return pages.renderHome(db);
    case "coursework":
      return pages.renderCoursework(db);
    case "track":
      return pages.renderTrack(db);
    case "channels":
      return pages.renderChannels(db);
    case "playlists":
      return pages.renderPlaylists(db);
    case "channel":
      return pages.renderChannel(db, param);
    case "playlist":
      return pages.renderPlaylist(db, param);
    case "watch":
      return pages.renderWatch(db, param);
    case "watchlater":
      return pages.renderWatchLater(db);
    case "history":
      return pages.renderHistory(db);
    case "search":
      return pages.renderSearch(db, param);
    case "settings":
      return pages.renderSettings(db);
    case "dashboard":
      return pages.renderDashboard(db);
    default:
      return pages.renderHome(db);
  }
}
