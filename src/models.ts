// What Apple calls things, as the app calls them.

import { art, playlistArt } from "./artwork.ts";
import { noteAudio } from "./lossless.ts";
import type { Resource } from "./types/apple.ts";
import type { Album, Artist, Playlist, Station, Track } from "./types/music.ts";
import { isCatalogID } from "./util.ts";

/** A song's catalog ID, which is what plays: library songs carry it in their playParams. */
export function songID(item: Resource): string {
  const play = item.attributes?.playParams;
  if (play?.catalogId) return String(play.catalogId);
  if (play?.reportingId && isCatalogID(play.reportingId)) return play.reportingId;
  return String(item.id);
}

function albumIdOf(item: Resource): string {
  const related = item.relationships?.albums?.data?.[0];
  if (related) return related.id;
  const m = (item.attributes?.url ?? "").match(/\/album\/[^/]+\/(\d+)/);
  return m ? m[1] : "";
}

const artistIdOf = (item: Resource): string => item.relationships?.artists?.data?.[0]?.id ?? "";

// An artist without an ID, by name: the artist page looks them up.
const byName = (name: string): Artist => ({ id: `name:${name}`, name });

export function toTrack(item: Resource): Track {
  const a = item.attributes ?? {};
  const id = songID(item);
  if (item.type === "songs") noteAudio(id, a);
  const artistName = a.artistName ?? "";
  const artists = [{ id: artistIdOf(item) || `name:${artistName}`, name: artistName }];
  return {
    id,
    name: a.name ?? "",
    artists,
    album: {
      id: albumIdOf(item),
      name: a.albumName ?? "",
      imageUrl: art(a.artwork),
      artists: a.albumArtistName ? [byName(a.albumArtistName)] : artists,
    },
    duration: a.durationInMillis ?? 0,
    url: a.url,
    unavailable: !isCatalogID(id) || (a.playParams === undefined && !item.id.startsWith("i.")),
  };
}

/** The songs among items: music videos and uploads that aren't in the catalog don't play. */
export const songsOf = (items: Resource[] | undefined): Track[] =>
  (items ?? []).filter((i) => i && (i.type === "songs" || i.type === "library-songs")).map(toTrack);

export function toAlbum(item: Resource): Album {
  const a = item.attributes ?? {};
  const catalogId = a.playParams?.catalogId;
  return {
    id: catalogId ? String(catalogId) : String(item.id),
    name: a.name ?? "",
    imageUrl: art(a.artwork),
    artists: a.artistName ? [{ id: artistIdOf(item) || `name:${a.artistName}`, name: a.artistName }] : [],
    released: a.releaseDate,
  };
}

export function toArtist(item: Resource): Artist {
  const a = item.attributes ?? {};
  return { id: String(item.id), name: a.name ?? "", imageUrl: art(a.artwork) };
}

export function toPlaylist(item: Resource): Playlist {
  const a = item.attributes ?? {};
  const library = item.type === "library-playlists";
  return {
    id: String(item.id),
    name: a.name ?? "",
    imageUrl: library ? playlistArt(a.artwork) : art(a.artwork),
    description: a.description?.standard || a.description?.short || a.editorialNotes?.short || "",
    owner: a.curatorName ?? "",
    trackCount: a.trackCount || undefined,
    mine: library && !!a.canEdit,
    saved: library && !a.canEdit,
  };
}

export function toStation(item: Resource): Station {
  const a = item.attributes ?? {};
  return {
    id: String(item.id),
    name: a.name ?? "",
    imageUrl: art(a.artwork),
    description: a.editorialNotes?.short ?? "",
  };
}
