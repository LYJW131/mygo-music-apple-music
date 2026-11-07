// The listener's library: what they played lately, their songs, albums and
// playlists, and what they favorite.

import { allPages, catalog, me } from "./api.ts";
import { songsOf, toAlbum, toPlaylist } from "./models.ts";
import { signedIn } from "./session.ts";
import type { Resource } from "./types/apple.ts";
import type { Album, Playlist, Track } from "./types/music.ts";
import { fail, isCatalogID } from "./util.ts";

export async function recentTracks(): Promise<Track[]> {
  const out: Track[] = [];
  for (let offset = 0; offset < 50; offset += 10) {
    const body = await me("/recent/played/tracks", { limit: 10, offset, types: "songs,library-songs" });
    out.push(...songsOf(body?.data));
    if (!body?.next) break;
  }
  return out;
}

export const recent = (): Promise<Track[]> => recentTracks();

// Liked songs are the songs in the library, newest first. Liking a song adds
// it to the listener's favorites, as the star in Apple's apps does, and to
// the library.

export async function liked({ offset = 0 }: { offset?: number }): Promise<{ tracks: Track[]; more: boolean }> {
  const body = await me("/library/songs", { limit: 100, offset: offset || undefined, include: "catalog" });
  return { tracks: songsOf(body?.data), more: !!body?.next };
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
  } else {
    await me(`/ratings/songs/${id}`, null, { method: "DELETE" });
  }
}

export async function savedAlbums({ offset = 0 }: { offset?: number }): Promise<{ albums: Album[]; more: boolean }> {
  const body = await me("/library/albums", { limit: 100, offset: offset || undefined });
  return { albums: (body?.data ?? []).map(toAlbum), more: !!body?.next };
}

/** The library's own resource for what of the catalog is in the library. */
export async function inLibrary(type: "albums" | "playlists", id: string): Promise<Resource | null> {
  if (!signedIn() || !/^(\d+|pl\.[\w.-]+)$/.test(id)) return null;
  const body = await catalog(`/${type}/${id}`, { relate: "library" }).catch(() => null);
  return body?.data?.[0]?.relationships?.library?.data?.[0] ?? null;
}

export async function saveAlbum({ id, on }: { id: string; on: boolean }): Promise<void> {
  if (on) {
    await me("/library", { "ids[albums]": id }, { method: "POST" });
    return;
  }
  const own = id.startsWith("l.") ? { id } : await inLibrary("albums", id);
  if (own) await me(`/library/albums/${own.id}`, null, { method: "DELETE" });
}

export async function savePlaylist({ id, on }: { id: string; on: boolean }): Promise<void> {
  if (on) {
    await me("/library", { "ids[playlists]": id }, { method: "POST" });
    return;
  }
  const own = id.startsWith("p.") ? { id } : await inLibrary("playlists", id);
  if (own) await me(`/library/playlists/${own.id}`, null, { method: "DELETE" });
}

export async function playlists(): Promise<Playlist[]> {
  return (await allPages("/v1/me/library/playlists", { limit: 100 }, 500)).map(toPlaylist);
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
}
