// What the plugin reads without asking Apple: TTML lyrics, pasted links,
// cover templates and Apple's resources.

import assert from "node:assert/strict";
import { test } from "node:test";
import { art, coverName, fileURL } from "../src/artwork.ts";
import { parseTTML } from "../src/lyrics.ts";
import { songsOf, toAlbum, toTrack } from "../src/models.ts";
import { parseAppleURL } from "../src/search.ts";

test("TTML: word timing, translations, background vocals, entities", () => {
  const ttml = `<tt xmlns="http://www.w3.org/ns/ttml" itunes:timing="Word"><head><metadata><iTunesMetadata><translations><translation type="subtitle" xml:lang="zh-Hans"><text for="L1">你好 世界</text></translation></translations></iTunesMetadata></metadata></head><body><div><p begin="1.5" end="3.000" itunes:key="L1"><span begin="1.5" end="2.0">Hello</span> <span begin="2.0" end="3.0">world</span><span ttm:role="x-bg"><span begin="2.5" end="2.9">(yeah)</span></span></p><p begin="1:02.25" end="1:04">Line &amp; two</p></div></body></tt>`;
  const parsed = parseTTML(ttml, "zh");
  assert.ok(parsed);
  assert.equal(parsed.lines.length, 2);
  assert.equal(parsed.lines[0].start, 1500);
  assert.equal(parsed.lines[0].end, 3000);
  assert.equal(parsed.lines[0].translation, "你好 世界");
  assert.deepEqual(
    parsed.lines[0].words?.map((w) => w.text),
    ["Hello ", "world"],
  );
  assert.equal(parsed.lines[1].start, 62250);
  assert.equal(parsed.lines[1].text, "Line & two");
  assert.equal(parseTTML(ttml, "en")?.lines[0].translation, undefined);
  assert.equal(parseTTML("<tt><body></body></tt>", "en"), null);
});

test("links from music.apple.com", () => {
  assert.deepEqual(parseAppleURL("https://music.apple.com/jp/album/x/1783644603?i=1783644604"), {
    kind: "album",
    id: "1783644603",
    song: "1783644604",
  });
  assert.deepEqual(parseAppleURL(" https://music.apple.com/us/playlist/pl.u-abc "), {
    kind: "playlist",
    id: "pl.u-abc",
    song: null,
  });
  assert.equal(parseAppleURL("MyGO!!!!!"), null);
});

test("covers", () => {
  assert.equal(
    art({ url: "https://is1-ssl.mzstatic.com/a/{w}x{h}bb.{f}" }),
    "https://is1-ssl.mzstatic.com/a/{size}x{size}bb.jpg",
  );
  assert.equal(art(undefined), undefined);
  assert.equal(
    coverName("https://store-030.blobstore.apple.com/sq/51/94/cc/5194CCF7-8d6a-655b-b9e2-00ef5180ed89/image?X-Amz=1"),
    "5194ccf7-8d6a-655b-b9e2-00ef5180ed89",
  );
  assert.equal(fileURL("/home/a b/cover.jpg"), "file:///home/a%20b/cover.jpg");
  assert.equal(fileURL("C:\\Users\\a\\cover.jpg"), "file:///C:/Users/a/cover.jpg");
});

test("songs: catalog IDs, library songs, what doesn't play", () => {
  const library = toTrack({
    id: "i.abc",
    type: "library-songs",
    attributes: {
      name: "迷星叫",
      artistName: "MyGO!!!!!",
      albumName: "迷跡波",
      durationInMillis: 1000,
      playParams: { catalogId: "1783644604" },
      url: "https://music.apple.com/jp/album/x/1783644603?i=1783644604",
    },
  });
  assert.equal(library.id, "1783644604");
  assert.equal(library.album.id, "1783644603");
  assert.equal(library.artists?.[0].id, "name:MyGO!!!!!");
  assert.equal(library.unavailable, false);
  const upload = toTrack({ id: "i.xyz", type: "library-songs", attributes: { name: "mine" } });
  assert.equal(upload.unavailable, true);
  assert.equal(songsOf([{ id: "1", type: "music-videos" }]).length, 0);
  assert.equal(
    toAlbum({ id: "l.abc", type: "library-albums", attributes: { playParams: { catalogId: 42 } } }).id,
    "42",
  );
});
