// Search, suggestions, and links from music.apple.com pasted into the search.

import { catalog, first } from "./api.ts";
import { songsOf, toAlbum, toArtist, toPlaylist } from "./models.ts";
import { album } from "./pages.ts";
import { listed, prefetch, warm } from "./prefetch.ts";
import type { Resource, SearchBody, SuggestionsBody } from "./types/apple.ts";
import type { SearchKind, SearchResult, Track } from "./types/music.ts";

const types: Record<SearchKind, string> = {
  tracks: "songs",
  albums: "albums",
  artists: "artists",
  playlists: "playlists",
};

const convert: Record<SearchKind, (items: Resource[]) => SearchResult[SearchKind]> = {
  tracks: songsOf,
  albums: (items) => items.map(toAlbum),
  artists: (items) => items.map(toArtist),
  playlists: (items) => items.map(toPlaylist),
};

export async function search({
  query: term,
  kind,
  offset = 0,
}: {
  query: string;
  kind: SearchKind;
  offset?: number;
}): Promise<SearchResult> {
  warm();
  const type = types[kind];
  if (!type) return { [kind]: [], more: false };
  const link = parseAppleURL(term);
  if (link && offset === 0) {
    const found = await fromLink(link, kind).catch(() => null);
    if (found) return found;
  }
  const body = await catalog<SearchBody>("/search", { term, types: type, limit: 25, offset: offset || undefined });
  const r = body?.results?.[type];
  const found = convert[kind](r?.data ?? []);
  // The app adds the next pages to the songs it lists, which play on into them.
  if (kind === "tracks") {
    const run = { key: `search:${term}`, start: !offset };
    if (offset) listed(found as Track[], run);
    else prefetch(found as Track[], run);
  }
  return { [kind]: found, more: !!r?.next };
}

export interface AppleLink {
  kind: "album" | "song" | "playlist" | "artist";
  id: string;
  /** The song an album link points at, by its ?i=. */
  song: string | null;
}

/** A music.apple.com link, if text is one. */
export function parseAppleURL(text: string): AppleLink | null {
  const m = text
    .trim()
    .match(/music\.apple\.com\/([a-z]{2})\/(album|song|playlist|artist)\/(?:[^/?#]+\/)?([^/?#]+)(?:\?([^#]*))?/);
  if (!m) return null;
  return { kind: m[2] as AppleLink["kind"], id: m[3], song: new URLSearchParams(m[4] ?? "").get("i") };
}

async function fromLink(link: AppleLink, kind: SearchKind): Promise<SearchResult | null> {
  if (link.kind === "song" || link.song) {
    if (kind !== "tracks") return null;
    return { tracks: songsOf((await catalog(`/songs/${link.song || link.id}`))?.data), more: false };
  }
  if (link.kind === "album" && kind === "albums") {
    return { albums: [toAlbum(first(await catalog(`/albums/${link.id}`)))], more: false };
  }
  if (link.kind === "album" && kind === "tracks") return { tracks: (await album({ id: link.id })).tracks, more: false };
  if (link.kind === "playlist" && kind === "playlists") {
    return { playlists: [toPlaylist(first(await catalog(`/playlists/${link.id}`)))], more: false };
  }
  if (link.kind === "artist" && kind === "artists") {
    return { artists: [toArtist(first(await catalog(`/artists/${link.id}`)))], more: false };
  }
  return null;
}

export async function suggest({ query: term }: { query: string }): Promise<string[]> {
  warm();
  if (!term?.trim()) return [];
  const body = await catalog<SuggestionsBody>("/search/suggestions", { term, kinds: "terms", limit: 10 });
  return (body?.results?.suggestions ?? []).map((s) => s.displayTerm || s.searchTerm || "").filter(Boolean);
}
