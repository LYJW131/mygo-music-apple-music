// Apple Music, for MyGo Music. The catalog, the listener's library and
// playlists, charts, recommendations, stations and word-timed lyrics come from
// the same API the web player at music.apple.com uses.
//
// Songs play whole, as the 256 kbps AAC the web player plays. Apple encrypts
// it with Widevine: the plugin asks Apple's license server for the key as the
// web player would, with a Widevine CDM written here in plain TypeScript, and
// ffmpeg takes the encryption off, copying the audio as it is into an .m4a the
// app plays. Nothing is re-encoded. No ALAC, no Dolby Atmos, and no wrapper.
//
// These exports are the plugin: what MyGo Music calls.

export { account, signIn, signOut } from "./account.ts";
export { browse, home } from "./browse.ts";
export {
  addToPlaylist,
  createPlaylist,
  isLiked,
  like,
  liked,
  playlists,
  recent,
  saveAlbum,
  savedAlbums,
  savePlaylist,
} from "./library.ts";
export { lyrics } from "./lyrics.ts";
export { album, artist, playlist } from "./pages.ts";
export { stream } from "./playback.ts";
export { search, suggest } from "./search.ts";
export { stationNext, stations } from "./stations.ts";
