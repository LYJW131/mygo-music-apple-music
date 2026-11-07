// Albums, artists and playlists, from the catalog or the library. Library
// IDs start with l. (albums) and p. (playlists); an artist the app only knows
// by name has the ID name:<name>.

import { allPages, catalog, first, me, storefront } from "./api.ts";
import { inLibrary } from "./library.ts";
import { songsOf, toAlbum, toArtist, toPlaylist } from "./models.ts";
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

export async function artist({ id }: { id: string }): Promise<ArtistPage> {
  warm();
  if (id.startsWith("name:")) {
    const body = await catalog<{ results?: { artists?: { data?: Resource[] } } }>("/search", {
      term: id.slice(5),
      types: "artists",
      limit: 1,
    });
    const found = body?.results?.artists?.data?.[0];
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

export async function playlist({ id }: { id: string }): Promise<Playlist> {
  warm();
  if (id.startsWith("p.")) {
    const [body, tracks] = await Promise.all([
      me(`/library/playlists/${id}`),
      allPages(`/v1/me/library/playlists/${id}/tracks`, { limit: 100 }, 5000).catch((e: unknown) => {
        if (codeOf(e) === "unavailable") return []; // an empty playlist has no tracks to find
        throw e;
      }),
    ]);
    const songs = songsOf(tracks);
    prefetch(songs);
    return { ...toPlaylist(first(body)), trackCount: songs.length, tracks: songs };
  }
  const [body, own] = await Promise.all([
    catalog(`/playlists/${id}`, { include: "tracks" }),
    inLibrary("playlists", id),
  ]);
  const item = first(body);
  let tracks = item.relationships?.tracks?.data ?? [];
  if (item.relationships?.tracks?.next) {
    tracks = await allPages(`/v1/catalog/${await storefront()}/playlists/${id}/tracks`, { limit: 300 }, 5000);
  }
  const songs = songsOf(tracks);
  prefetch(songs);
  return { ...toPlaylist(item), saved: !!own, trackCount: songs.length, tracks: songs };
}
