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
    "played",
    "playlist",
    "playlists",
    "recent",
    "saveAlbum",
    "savePlaylist",
    "savedAlbums",
    "search",
    "setSetting",
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
  // A song they uploaded is theirs too; what's neither doesn't play.
  await assert.rejects(
    () => api.stream({ id: "i.abc" }),
    (e: { code?: string }) => e.code === "signIn",
  );
  await assert.rejects(
    () => api.stream({ id: "ra.abc" }),
    (e: { code?: string }) => e.code === "unavailable",
  );
});

test("a media-user-token given in the settings signs in, and out once it's emptied", async () => {
  const settings: Record<string, string> = {};
  const { api, storage } = await load({ settings, language: "en" });
  // As copied from a browser: the cookie header, with others around it.
  settings.mediaUserToken = "Cookie: geo=US; media-user-token=AbC+/12=; itspod=55";
  await api.setSetting({ key: "mediaUserToken", value: settings.mediaUserToken });
  assert.equal(storage.get("mediaUserToken"), "AbC+/12=");

  // Signing out leaves it signed out, though the setting is still there.
  await api.signOut();
  assert.equal(await api.account(), null);

  // The header as some tools copy it, without a space.
  settings.mediaUserToken = "cookie:media-user-token=Spaceless";
  await api.setSetting({ key: "mediaUserToken", value: settings.mediaUserToken });
  assert.equal(storage.get("mediaUserToken"), "Spaceless");

  // Another token, or the token alone, signs in with it.
  settings.mediaUserToken = ' "XyZ" ';
  await api.setSetting({ key: "mediaUserToken", value: settings.mediaUserToken });
  assert.equal(storage.get("mediaUserToken"), "XyZ");

  // Not a token: said, and whoever is signed in stays.
  settings.mediaUserToken = "geo=US; itspod=55";
  await assert.rejects(
    () => api.setSetting({ key: "mediaUserToken", value: settings.mediaUserToken }),
    (e: { code?: string }) => e.code === "setup",
  );
  assert.equal(storage.get("mediaUserToken"), "XyZ");

  // Emptied, it signs out, without asking Apple.
  settings.mediaUserToken = "";
  await api.setSetting({ key: "mediaUserToken", value: "" });
  assert.equal(storage.get("mediaUserToken"), undefined);
  assert.equal(await api.account(), null);
});

test("a token signed in with another way stays when the setting is emptied", async () => {
  const settings: Record<string, string> = { mediaUserToken: "Old" };
  const storage = new Map<string, unknown>([
    ["givenToken", "Old"],
    ["mediaUserToken", "FromTheWindow"],
  ]);
  const { api } = await load({ settings, storage });
  settings.mediaUserToken = "";
  await api.setSetting({ key: "mediaUserToken", value: "" });
  assert.equal(storage.get("mediaUserToken"), "FromTheWindow");
  assert.equal(storage.has("givenToken"), false);
});

test("speaks the listener's language", async () => {
  const { api } = await load({ language: "zh-CN" });
  await assert.rejects(() => api.stream({ id: "ra.abc" }), /Apple Music 无法播放这首歌/);
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
