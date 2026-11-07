// Apple Music, for MyGo Music. The catalog, the listener's library and
// playlists, charts, recommendations, stations and word-timed lyrics come from
// the same API the web player at music.apple.com uses.
//
// Songs play whole, as the 256 kbps AAC the web player plays. Apple encrypts
// it with Widevine: the plugin asks Apple's license server for the key as the
// web player would, with a Widevine CDM written here in plain TypeScript, and
// ffmpeg takes the encryption off, copying the audio as it is into an .m4a the
// app plays. Nothing is re-encoded. With the listener's wrapper, songs play
// lossless as ALAC instead (lossless.ts).
//
// These exports are the plugin: what MyGo Music calls. While the app waits on
// one, what's fetched of the library ahead waits too (background.ts).

import * as acc from "./account.ts";
import { foreground } from "./background.ts";
import * as br from "./browse.ts";
import * as lib from "./library.ts";
import * as ly from "./lyrics.ts";
import * as pg from "./pages.ts";
import * as pb from "./playback.ts";
import * as se from "./search.ts";
import * as st from "./stations.ts";
import { stopWarming, warmLibrary } from "./warmup.ts";

// The app's ask, which also starts fetching the library ahead, once it's
// quiet. Only the app's one object of parameters is passed on: a second
// argument tells a function it works in the background.
function asked<P, R>(fn: (params: P) => R | Promise<R>): (params: P) => Promise<R> {
  const call = foreground(fn);
  return (params: P) => {
    warmLibrary();
    return call(params);
  };
}

export const account = asked(acc.account);
export const signIn = asked(() => {
  stopWarming();
  return acc.signIn();
});
export const signOut = asked(() => {
  stopWarming();
  acc.signOut();
});
export const home = asked(br.home);
export const browse = asked(br.browse);
export const recent = asked(lib.recent);
export const liked = asked((p: { offset?: number }) => lib.liked(p));
export const isLiked = asked(lib.isLiked);
export const like = asked(lib.like);
export const savedAlbums = asked((p: { offset?: number }) => lib.savedAlbums(p));
export const saveAlbum = asked(lib.saveAlbum);
export const savePlaylist = asked(lib.savePlaylist);
export const createPlaylist = asked(lib.createPlaylist);
export const addToPlaylist = asked(lib.addToPlaylist);
export const playlists = asked(async () => {
  const lists = await lib.playlists();
  // The app lists them as it comes to the front: what changed is fetched again.
  warmLibrary(1000);
  return lists;
});
export const lyrics = asked(ly.lyrics);
export const album = asked(pg.album);
export const artist = asked(pg.artist);
export const playlist = asked(pg.playlist);
export const stream = asked(pb.stream);
export const search = asked(se.search);
export const suggest = asked(se.suggest);
export const stations = asked(() => st.stations());
export const stationNext = asked(st.stationNext);
