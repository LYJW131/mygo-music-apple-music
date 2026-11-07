// The built plugin, loaded as MyGo Music loads it, without asking Apple
// anything: what it exports, and what it says signed out.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { dist, load } from "./harness.ts";

test("exports what the app calls, and nothing else", async () => {
  const { api } = await load();
  assert.deepEqual(Object.keys(api).sort(), [
    "account",
    "addToPlaylist",
    "album",
    "artist",
    "browse",
    "createPlaylist",
    "home",
    "isLiked",
    "like",
    "liked",
    "lyrics",
    "playlist",
    "playlists",
    "recent",
    "saveAlbum",
    "savePlaylist",
    "savedAlbums",
    "search",
    "signIn",
    "signOut",
    "stationNext",
    "stations",
    "stream",
    "suggest",
  ]);
});

test("signed out, the library asks to sign in, before asking Apple", async () => {
  const { api } = await load();
  assert.equal(await api.account(), null);
  for (const call of [
    () => api.playlists(),
    () => api.liked({ offset: 0 }),
    () => api.savedAlbums({ offset: 0 }),
    () => api.browse({ page: "recentlyAdded" }),
    () => api.stream({ id: "1783644604" }),
  ]) {
    await assert.rejects(call, (e: { code?: string }) => e.code === "signIn");
  }
  assert.equal((await api.stations()).length, 0);
  assert.equal(await api.lyrics({ id: "1783644604" }), null);
  await assert.rejects(
    () => api.stream({ id: "i.abc" }),
    (e: { code?: string }) => e.code === "unavailable",
  );
});

test("speaks the listener's language", async () => {
  const { api } = await load({ language: "zh-CN" });
  await assert.rejects(() => api.stream({ id: "i.abc" }), /只能播放 Apple Music 曲库里的歌曲/);
});

test("plugin.json and the locales ship, and every text and setting has its Chinese", async () => {
  const manifest = JSON.parse(await readFile(join(dist, "plugin.json"), "utf8"));
  assert.equal(manifest.main, "index.js");
  const locale = JSON.parse(await readFile(join(dist, "locales/zh-CN.json"), "utf8")) as Record<string, string>;
  const source = await readFile(join(dist, "index.js"), "utf8");
  const texts = [...source.matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"\s*,?\s*\)/g)].map((m) => JSON.parse(`"${m[1]}"`));
  const titles = (manifest.navigation as { title?: string }[]).map((n) => n.title).filter(Boolean);
  const settings = (manifest.settings as { label: string; help?: string }[]).flatMap((s) => [s.label, s.help]);
  assert.ok(texts.length > 20);
  for (const text of [...texts, ...titles, ...settings].filter(Boolean)) {
    assert.ok(locale[text!], `no Chinese for ${JSON.stringify(text)}`);
  }
});
