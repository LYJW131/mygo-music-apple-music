// Signed out, against the real Apple Music: search, albums, artists,
// playlists and charts. Not part of npm test, as it depends on Apple.
import assert from "node:assert/strict";
import type { Section } from "../src/types/music.ts";
import { load } from "./harness.ts";

const { api } = await load();

const songs = await api.search({ query: "MyGO!!!!! 迷星叫", kind: "tracks", offset: 0 });
assert.ok(songs.tracks.length > 0, "search songs");
const song = songs.tracks[0];
console.log("song:", song.id, song.name, "/", song.artists[0].name, "/", song.album.name, song.album.imageUrl);
const next = await api.search({ query: "MyGO!!!!!", kind: "tracks", offset: 25 });
console.log("page 2:", next.tracks.length, "more", next.more);

const albums = await api.search({ query: "MyGO!!!!!", kind: "albums", offset: 0 });
const album = await api.album({ id: albums.albums[0].id });
console.log("album:", album.album.name, album.tracks.length, "tracks");
assert.ok(album.tracks.length > 0);

const artists = await api.search({ query: "MyGO!!!!!", kind: "artists", offset: 0 });
const artist = await api.artist({ id: artists.artists[0].id });
console.log("artist:", artist.artist.name, artist.tracks.length, "top songs,", artist.albums.length, "albums");
const byName = await api.artist({ id: song.album.artists[0].id });
console.log("artist by name:", byName.artist.name);

const lists = await api.search({ query: "anime", kind: "playlists", offset: 0 });
const list = await api.playlist({ id: lists.playlists[0].id });
console.log("playlist:", list.name, list.tracks.length, "tracks");

const fromLink = await api.search({
  query: "https://music.apple.com/jp/album/x/1783644603?i=1783644604",
  kind: "tracks",
  offset: 0,
});
console.log(
  "link:",
  fromLink.tracks.map((t: { name: string }) => t.name),
);

console.log("suggest:", await api.suggest({ query: "mygo" }));
const home = await api.home();
console.log(
  "home:",
  home.sections.map((s: Section) => `${s.title} (${(s.tracks || s.albums || s.playlists || []).length})`).join(", "),
);
const charts = await api.browse({ page: "charts" });
console.log(
  "charts:",
  charts.sections.map((s: Section) => `${s.title} (${(s.tracks || s.albums || s.playlists || []).length})`).join(", "),
);
