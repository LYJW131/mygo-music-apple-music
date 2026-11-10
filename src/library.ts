// The listener's library: what they played lately, their songs, albums and
// playlists, and what they favorite.

import { allPages, catalog, first, me } from "./api.ts";
import { forget, forgetAll, kept } from "./background.ts";
import { songID, songsOf, toAlbum, toPlaylist } from "./models.ts";
import { prefetch, shown } from "./prefetch.ts";
import { signedIn } from "./session.ts";
import type { Resource } from "./types/apple.ts";
import type { Album, Playlist, Track } from "./types/music.ts";
import { codeOf, fail, isCatalogID, isLibrarySong, t } from "./util.ts";

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
  edits.clear();
  favoritesID = undefined;
}

/** The listener's playlists, Favorite Songs among them, from Apple. */
export function libraryPlaylists(ahead = false): Promise<Resource[]> {
  // The app's own ask always goes to Apple: the list is what says what changed.
  return kept(
    "playlists",
    { maxAge: ahead ? 60 * 1000 : 0 },
    async (pause, urgent) => {
      const lists = await allPages("/v1/me/library/playlists", { limit: 100 }, 500, pause, urgent);
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
  return lists
    .filter((p) => p.id !== favoritesID)
    .map((p) => asEdited(toPlaylist(p)))
    .filter((p): p is Playlist => !!p);
}

export async function createPlaylist({ name }: { name: string }): Promise<Playlist> {
  const body = await me("/library/playlists", null, { method: "POST", body: { attributes: { name } } });
  const made = body?.data?.[0];
  if (!made) throw new Error("Apple Music didn't make the playlist");
  return { ...toPlaylist(made), mine: true, tracks: [] };
}

export async function addToPlaylist({ id, trackIds }: { id: string; trackIds: string[] }): Promise<void> {
  // An upload goes by its library ID, as Apple's API takes it.
  const data = trackIds
    .filter((song) => isCatalogID(song) || isLibrarySong(song))
    .map((song) => ({ id: song, type: isCatalogID(song) ? "songs" : "library-songs" }));
  if (!data.length) return;
  await me(`/library/playlists/${id}/tracks`, null, { method: "POST", body: { data } });
  // What it now holds is Apple's to say: songs kept from an edit would leave these out.
  const e = edits.get(id);
  if (e) e.tracks = undefined;
  forget(`playlist:${id}`);
}

// Editing the listener's own playlists, as the web player does: a new name
// is PATCHed, a playlist is DELETEd, a song is taken out by its library ID,
// and a new order is PUT as the whole list of its tracks.
//
// Apple takes a change at once but may answer with the playlist as it was
// for a minute or two after, with the date it last changed as it was too, so
// that what's kept of it would be the old one again. Until Apple catches up,
// the plugin answers with what the listener made of it, so that what the app
// shows isn't undone by reading it back, and the next change starts from it,
// not from the past.

/** How long the plugin answers with a change: by then Apple has it, or someone changed it elsewhere. */
const EDIT_SETTLES = 5 * 60 * 1000;

interface Edit {
  at: number;
  /** Its new name, if it was renamed. */
  name?: string;
  deleted?: boolean;
  /** All its tracks as they are now, music videos among them, if they changed. */
  tracks?: Resource[];
}

const edits = new Map<string, Edit>();

/** What the listener lately changed of playlist id. */
export function edited(id: string): Edit | undefined {
  const e = edits.get(id);
  if (e && Date.now() - e.at > EDIT_SETTLES) {
    edits.delete(id);
    return undefined;
  }
  return e;
}

/** Keeps what change made of playlist id, which Apple took, and forgets it as it was kept. */
function noteEdit(id: string, change: (e: Edit) => void): void {
  const e = edited(id) ?? { at: 0 };
  change(e);
  e.at = Date.now();
  edits.set(id, e);
  forget(`playlist:${id}`);
}

/** pl as the listener last changed it, or null for one they deleted. Its tracks are left as they are. */
export function asEdited(pl: Playlist): Playlist | null {
  const e = edited(pl.id);
  if (e?.deleted) return null;
  return e?.name ? { ...pl, name: e.name } : pl;
}

const changedElsewhere = () => fail("unsupported", t("The playlist changed elsewhere. Try again in a moment."));

/** All of playlist id's tracks as they are now: as the listener last changed them, or else as Apple answers, asked anew. */
async function playlistTracks(id: string): Promise<Resource[]> {
  const e = edited(id);
  if (e?.tracks) return e.tracks;
  return allPages(`/v1/me/library/playlists/${id}/tracks`, { limit: 100 }, 5000).catch((err: unknown) => {
    if (codeOf(err) === "unavailable") return []; // an empty playlist has no tracks to find
    throw err;
  });
}

export async function renamePlaylist({ id, name }: { id: string; name: string }): Promise<void> {
  await me(`/library/playlists/${id}`, null, { method: "PATCH", body: { attributes: { name } } });
  noteEdit(id, (e) => (e.name = name));
}

export async function deletePlaylist({ id }: { id: string }): Promise<void> {
  await me(`/library/playlists/${id}`, null, { method: "DELETE" });
  noteEdit(id, (e) => (e.deleted = true));
  forget("recentlyAdded");
}

/**
 * Takes songs out by their library IDs, which the playlist's tracks are: the
 * app knows a song by its catalog ID, and an upload by its library ID
 * already. mode=all takes out every time a song is listed, as the app does.
 */
export async function removeFromPlaylist({ id, trackIds }: { id: string; trackIds: string[] }): Promise<void> {
  const tracks = await playlistTracks(id);
  const out = new Set(trackIds);
  const gone = [
    ...new Set(
      tracks.filter((x) => x.type === "library-songs" && (out.has(songID(x)) || out.has(x.id))).map((x) => x.id),
    ),
  ];
  if (!gone.length) {
    forget(`playlist:${id}`);
    throw changedElsewhere();
  }
  const done: string[] = [];
  try {
    for (const song of gone) {
      await me(`/library/playlists/${id}/tracks`, { "ids[library-songs]": song, mode: "all" }, { method: "DELETE" });
      done.push(song);
    }
  } finally {
    if (done.length) noteEdit(id, (e) => (e.tracks = tracks.filter((x) => !done.includes(x.id))));
  }
}

/** Moves a song from and to places among the songs, which are what the app lists: music videos stay where they are. */
export async function movePlaylistTrack({ id, from, to }: { id: string; from: number; to: number }): Promise<void> {
  const tracks = await playlistTracks(id);
  const at = tracks.flatMap((x, i) => (x.type === "songs" || x.type === "library-songs" ? [i] : []));
  if (from < 0 || to < 0 || from >= at.length || to >= at.length) {
    forget(`playlist:${id}`);
    throw changedElsewhere();
  }
  const songs = at.map((i) => tracks[i]);
  const [moving] = songs.splice(from, 1);
  songs.splice(to, 0, moving);
  const order = [...tracks];
  at.forEach((i, n) => (order[i] = songs[n]));
  const data = order.map((x) => ({ id: x.id, type: x.type }));
  await me(`/library/playlists/${id}/tracks`, null, { method: "PUT", body: { data } });
  noteEdit(id, (e) => (e.tracks = order));
}
