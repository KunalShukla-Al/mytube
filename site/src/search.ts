// Client-side fuzzy search over titles + channel names.

import Fuse from "fuse.js";
import type { Video } from "./data";

let fuse: Fuse<Video> | null = null;

export function buildIndex(videos: Video[]): void {
  fuse = new Fuse(videos, {
    keys: [
      { name: "title", weight: 0.8 },
      { name: "channel.name", weight: 0.2 },
    ],
    threshold: 0.38,
    ignoreLocation: true,
    minMatchCharLength: 2,
  });
}

export function search(query: string, limit = 60): Video[] {
  if (!fuse || !query.trim()) return [];
  return fuse.search(query.trim(), { limit }).map((r) => r.item);
}
