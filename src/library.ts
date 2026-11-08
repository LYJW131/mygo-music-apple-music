// The listener's library: what they played lately, their songs, albums and
// playlists, and what they favorite.

import { allPages, catalog, first, me } from "./api.ts";
import { forget, forgetAll, kept } from "./background.ts";
import { songsOf, toAlbum, toPlaylist } from "./models.ts";
import { prefetch, shown } from "./prefetch.ts";
import { signedIn } from "./session.ts";
import type { Resource } from "./types/apple.ts";
import type { Album, Playlist, Track } from "./types/music.ts";
import { codeOf, fail, isCatalogID } from "./util.ts";

/** How long what can't tell when it changed is kept: favorites, albums, stations. */
export const LIST_KEPT = 10 * 60 * 1000;

// The listener's playlists as last listed, each with when it last changed,
// which tells whether a playlist fetched before is still as it was.
const changed = new Map<string, string>();
// Favorite Songs: the playlist Apple keeps of the songs they favorite,
// which can't be deleted and isn't in the catalog. null when there's none.
let favoritesID: string | null | undefined;

/** Forgets what was kept of the listener, who signed out or in. */
export function forgetLibrary(): void {
  forgetAll();
  changed.clear();
  favoritesID = undefined;
}

/** The listener's playlists, Favorite Songs among them, from Apple. */
export function libraryPlaylists(ahead = false): Promise<Resource[]> {
  // The app's own ask always goes to Apple: the list is what says what changed.
  return kept(
    "playlists",
    { maxAge: ahead ? 60 * 1000 : 0 },
    async (pause) => {
      const lists = await allPages("/v1/me/library/playlists", { limit: 100 }, 500, pause);
      changed.clear();
      favoritesID = null;
      for (const p of lists) {
        const a = p.attributes ?? {};
        if (a.lastModifiedDate) changed.set(p.id, a.lastModifiedDate);
        if (a.canDelete === false && !a.hasCatalog) favoritesID = p.id;
      }
      return lists;
    },
    ahead,
  );
}

/** How a library playlist fetched before stays good: as long as it hasn't changed. */
export function playlistFreshness(id: string) {
  const version = changed.get(id);
  return version ? { version, maxAge: Infinity } : { maxAge: LIST_KEPT };
}

/** The listener's playlists by when they last changed, the latest first, but Favorite Songs. */
export const recentlyChanged = (): string[] =>
  [...changed.entries()]
    .filter(([id]) => id !== favoritesID)
    .sort((a, b) => b[1].localeCompare(a[1]))
    .map(([id]) => id);

export async function recentTracks(): Promise<Track[]> {
  const out: Track[] = [];
  for (let offset = 0; offset < 50; offset += 10) {
    const body = await me("/recent/played/tracks", { limit: 10, offset, types: "songs,library-songs" });
    out.push(...songsOf(body?.data));
    if (!body?.next) break;
  }
  return out;
}

// The app lists these in place of home, when it has nothing, and loads them
// as it loads home.
export const recent = (): Promise<Track[]> =>
  recentTracks().then((tracks) => {
    shown(tracks);
    return tracks;
  });

// Liked songs are Favorite Songs, newest first, as Apple's apps list them.
// Liking a song favorites it, as the star in Apple's apps does, which puts it
// in Favorite Songs and the library. An account without Favorite Songs lists
// its library's songs.

export async function liked(
  { offset = 0 }: { offset?: number },
  ahead = false,
): Promise<{ tracks: Track[]; more: boolean }> {
  if (favoritesID === undefined) await libraryPlaylists(ahead);
  const favorites = favoritesID;
  const version = favorites ? changed.get(favorites) : undefined;
  return kept(
    `liked:${offset}`,
    { version, maxAge: LIST_KEPT },
    async () => {
      const path = favorites ? `/library/playlists/${favorites}/tracks` : "/library/songs";
      const body = await me(path, { limit: 100, offset: offset || undefined, include: "catalog" }).catch((e) => {
        if (codeOf(e) === "unavailable") return null; // none yet
        throw e;
      });
      return { tracks: songsOf(body?.data), more: !!body?.next };
    },
    ahead,
  ).then((page) => {
    if (!ahead) prefetch(page.tracks);
    return page;
  });
}

export async function isLiked({ ids }: { ids: string[] }): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = Object.fromEntries(ids.map((id) => [id, false]));
  const catalogIds = ids.filter(isCatalogID);
  if (!signedIn() || !catalogIds.length) return out;
  for (let i = 0; i < catalogIds.length; i += 100) {
    const body = await me("/ratings/songs", { ids: catalogIds.slice(i, i + 100).join(",") });
    for (const r of body?.data ?? []) out[r.id] = r.attributes?.value === 1;
  }
  return out;
}

export async function like({ id, on }: { id: string; on: boolean }): Promise<void> {
  if (!isCatalogID(id)) throw fail("unsupported");
  if (on) {
    await me(`/ratings/songs/${id}`, null, { method: "PUT", body: { type: "rating", attributes: { value: 1 } } });
    await me("/library", { "ids[songs]": id }, { method: "POST" }).catch(() => {});
    forget("recentlyAdded");
  } else {
    await me(`/ratings/songs/${id}`, null, { method: "DELETE" });
  }
  forget("liked:");
  if (favoritesID) forget(`playlist:${favoritesID}`);
}

export function savedAlbums(
  { offset = 0 }: { offset?: number },
  ahead = false,
): Promise<{ albums: Album[]; more: boolean }> {
  return kept(
    `albums:${offset}`,
    { maxAge: LIST_KEPT },
    async () => {
      const body = await me("/library/albums", { limit: 100, offset: offset || undefined });
      return { albums: (body?.data ?? []).map(toAlbum), more: !!body?.next };
    },
    ahead,
  );
}

/** The library's own resource for what of the catalog is in the library. */
export async function inLibrary(type: "albums" | "playlists", id: string): Promise<Resource | null> {
  if (!signedIn() || !/^(\d+|pl\.[\w.-]+)$/.test(id)) return null;
  const body = await catalog(`/${type}/${id}`, { relate: "library" }).catch(() => null);
  return body?.data?.[0]?.relationships?.library?.data?.[0] ?? null;
}

export async function saveAlbum({ id, on }: { id: string; on: boolean }): Promise<void> {
  forget("albums:");
  forget("recentlyAdded");
  if (on) {
    await me("/library", { "ids[albums]": id }, { method: "POST" });
    return;
  }
  const own = id.startsWith("l.") ? { id } : await inLibrary("albums", id);
  if (own) await me(`/library/albums/${own.id}`, null, { method: "DELETE" });
}

export async function savePlaylist({ id, on }: { id: string; on: boolean }): Promise<void> {
  forget("recentlyAdded");
  if (on) {
    await me("/library", { "ids[playlists]": id }, { method: "POST" });
    return;
  }
  const own = id.startsWith("p.") ? { id } : await inLibrary("playlists", id);
  if (!own) return;
  // Unsaving takes a playlist out of the library, which for one the listener
  // made deletes it: only one saved from someone else goes.
  if (first(await me(`/library/playlists/${own.id}`)).attributes?.canEdit) throw fail("unsupported");
  await me(`/library/playlists/${own.id}`, null, { method: "DELETE" });
}

/** The sidebar's playlists: Favorite Songs is the app's own Liked page. */
export async function playlists(): Promise<Playlist[]> {
  const lists = await libraryPlaylists();
  return lists.filter((p) => p.id !== favoritesID).map(toPlaylist);
}

export async function createPlaylist({ name }: { name: string }): Promise<Playlist> {
  const body = await me("/library/playlists", null, { method: "POST", body: { attributes: { name } } });
  const made = body?.data?.[0];
  if (!made) throw new Error("Apple Music didn't make the playlist");
  return { ...toPlaylist(made), mine: true, tracks: [] };
}

export async function addToPlaylist({ id, trackIds }: { id: string; trackIds: string[] }): Promise<void> {
  const data = trackIds.filter(isCatalogID).map((song) => ({ id: song, type: "songs" }));
  if (!data.length) return;
  await me(`/library/playlists/${id}/tracks`, null, { method: "POST", body: { data } });
  forget(`playlist:${id}`);
}
