// Albums, artists and playlists, from the catalog or the library. Library
// IDs start with l. (albums) and p. (playlists); an artist the app only knows
// by name has the ID name:<name>, and by a song or album of theirs
// of:<songs|albums>:<ID>:<name> (artistOf).

import { allPages, catalog, first, me, storefront } from "./api.ts";
import { kept } from "./background.ts";
import { edited, inLibrary, playlistFreshness } from "./library.ts";
import { artistOfParts, songsOf, toAlbum, toArtist, toPlaylist } from "./models.ts";
import { prefetch, warm } from "./prefetch.ts";
import type { Resource } from "./types/apple.ts";
import type { AlbumPage, ArtistPage, Playlist } from "./types/music.ts";
import { codeOf, fail, t } from "./util.ts";

export async function album({ id }: { id: string }): Promise<AlbumPage> {
  warm();
  if (id.startsWith("l.")) {
    const item = first(await me(`/library/albums/${id}`, { include: "tracks" }));
    const songs = songsOf(await allPages(`/v1/me/library/albums/${id}/tracks`, { limit: 100 }));
    prefetch(songs);
    return { album: { ...toAlbum(item), id, saved: true }, tracks: songs };
  }
  const [body, own] = await Promise.all([
    catalog(`/albums/${id}`, { include: "tracks,artists" }),
    inLibrary("albums", id),
  ]);
  const item = first(body);
  let tracks = item.relationships?.tracks?.data ?? [];
  if (item.relationships?.tracks?.next) {
    tracks = await allPages(`/v1/catalog/${await storefront()}/albums/${id}/tracks`, { limit: 300 });
  }
  const songs = songsOf(tracks);
  prefetch(songs);
  return { album: { ...toAlbum(item), saved: !!own }, tracks: songs };
}

/**
 * The one of found named name: the first so named, else the first so named
 * but for case, else the first. Apple's search puts LISA before LiSA in some
 * storefronts, whichever is asked for.
 */
export function named(found: Resource[], name: string): Resource | undefined {
  return (
    found.find((r) => r.attributes?.name === name) ??
    found.find((r) => r.attributes?.name?.toLowerCase() === name.toLowerCase()) ??
    found[0]
  );
}

export async function artist({ id }: { id: string }): Promise<ArtistPage> {
  warm();
  const of = artistOfParts(id);
  if (of) {
    // The artists of the song or album itself; by name only if the catalog doesn't say.
    const body = await catalog(`/${of.type}/${of.of}/artists`, { limit: 10 }).catch(() => null);
    const found = named(body?.data ?? [], of.name);
    id = found ? found.id : `name:${of.name}`;
  }
  if (id.startsWith("name:")) {
    const name = id.slice(5);
    const body = await catalog<{ results?: { artists?: { data?: Resource[] } } }>("/search", {
      term: name,
      types: "artists",
      limit: 10,
    });
    const found = named(body?.results?.artists?.data ?? [], name);
    if (!found) throw fail("unavailable", t("Apple Music doesn't have this"));
    id = found.id;
  }
  const item = first(await catalog(`/artists/${id}`, { views: "top-songs,full-albums,singles" }));
  const views = item.views ?? {};
  const albums = [...(views["full-albums"]?.data ?? []), ...(views.singles?.data ?? [])].map(toAlbum);
  const top = songsOf(views["top-songs"]?.data);
  prefetch(top);
  return { artist: toArtist(item), tracks: top, albums };
}

/** One of the listener's playlists, kept until it changes. */
export function libraryPlaylist(id: string, ahead = false): Promise<Playlist> {
  return kept(
    `playlist:${id}`,
    playlistFreshness(id),
    async (pause, urgent) => {
      const body = await me(`/library/playlists/${id}`);
      await pause();
      const tracks = await allPages(`/v1/me/library/playlists/${id}/tracks`, { limit: 100 }, 5000, pause, urgent).catch(
        (e: unknown) => {
          if (codeOf(e) === "unavailable") return []; // an empty playlist has no tracks to find
          throw e;
        },
      );
      const songs = songsOf(tracks);
      return { ...toPlaylist(first(body)), trackCount: songs.length, tracks: songs };
    },
    ahead,
  );
}

export async function playlist({ id }: { id: string }): Promise<Playlist> {
  warm();
  if (id.startsWith("p.")) {
    let found = await libraryPlaylist(id);
    // As the listener last changed it, which Apple may not answer with yet.
    const e = edited(id);
    if (e?.deleted) throw fail("unavailable", t("Apple Music doesn't have this"));
    if (e?.name) found = { ...found, name: e.name };
    if (e?.tracks) {
      const tracks = songsOf(e.tracks);
      found = { ...found, tracks, trackCount: tracks.length };
    }
    prefetch(found.tracks ?? []);
    return found;
  }
  const [body, own] = await Promise.all([
    catalog(`/playlists/${id}`, { include: "tracks" }),
    inLibrary("playlists", id),
  ]);
  // The listener's own playlist by its catalog ID, as Apple's Recently Played
  // lists it, is opened as their library's: the app then offers to edit it, and
  // not to unsave it, which would delete it.
  if (own && id.startsWith("pl.u-")) {
    const theirs = await me(`/library/playlists/${own.id}`).catch(() => null);
    if (theirs?.data?.[0]?.attributes?.canEdit) return playlist({ id: own.id });
  }
  const item = first(body);
  let tracks = item.relationships?.tracks?.data ?? [];
  if (item.relationships?.tracks?.next) {
    tracks = await allPages(`/v1/catalog/${await storefront()}/playlists/${id}/tracks`, { limit: 300 }, 5000);
  }
  const songs = songsOf(tracks);
  prefetch(songs);
  return { ...toPlaylist(item), saved: !!own, trackCount: songs.length, tracks: songs };
}
