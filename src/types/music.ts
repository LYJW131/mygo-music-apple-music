// What the app takes from a plugin, by the JSON names of MyGo Music's
// internal/music/music.go. Times are in milliseconds.

export interface Artist {
  id: string;
  name: string;
  imageUrl?: string;
}

export interface Album {
  id: string;
  name: string;
  imageUrl?: string;
  artists?: Artist[];
  released?: string;
  saved?: boolean;
}

export interface Track {
  id: string;
  name: string;
  artists?: Artist[];
  album: Album;
  duration: number;
  url?: string;
  unavailable?: boolean;
}

export interface Playlist {
  id: string;
  name: string;
  imageUrl?: string;
  description?: string;
  owner?: string;
  trackCount?: number;
  mine?: boolean;
  saved?: boolean;
  tracks?: Track[];
}

export interface Station {
  id: string;
  name: string;
  description?: string;
  imageUrl?: string;
}

export interface Section {
  title?: string;
  tracks?: Track[];
  albums?: Album[];
  artists?: Artist[];
  playlists?: Playlist[];
  stations?: Station[];
  morePage?: string;
  empty?: string;
}

export interface Browse {
  title?: string;
  subtitle?: string;
  sections?: Section[];
}

export interface AlbumPage {
  album: Album;
  tracks: Track[];
}

export interface ArtistPage {
  artist: Artist;
  tracks: Track[];
  albums: Album[];
}

export interface Account {
  id: string;
  name: string;
  imageUrl?: string;
}

export type SearchKind = "tracks" | "albums" | "artists" | "playlists";

export interface SearchResult {
  tracks?: Track[];
  albums?: Album[];
  artists?: Artist[];
  playlists?: Playlist[];
  more: boolean;
}

export interface Stream {
  url: string;
  type: string;
  quality?: string;
  bitRate?: number;
}

export interface LyricWord {
  start: number;
  end: number;
  text: string;
}

export interface LyricLine {
  start: number;
  end: number;
  text: string;
  translation?: string;
  words?: LyricWord[];
}

export interface Lyrics {
  lines: LyricLine[];
}
