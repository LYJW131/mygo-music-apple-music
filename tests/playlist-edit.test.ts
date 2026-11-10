// Editing the listener's own playlists: offline, against a stand-in for Apple
// that is slow to catch up, as Apple is, answering with the playlist as it
// was until it's told to catch up.
import assert from "node:assert/strict";
import { test } from "node:test";

const jwt = `x.${btoa(JSON.stringify({ exp: Date.now() / 1000 + 86400 }))}.y`;
const storage = new Map<string, unknown>([
  ["devToken", jwt],
  ["mediaUserToken", "token"],
  ["storefront", "us"],
]);
(globalThis as any).host = {
  platform: "linux",
  arch: "x64",
  storage: {
    get: (k: string) => storage.get(k),
    set: (k: string, v: unknown) => void storage.set(k, v),
    remove: (k: string) => void storage.delete(k),
  },
  setting: () => "",
  t: (text: string) => text,
  language: () => "en",
  spawn: () => {
    throw new Error("no programs here");
  },
};

// The playlist's tracks: two songs of the catalog, a music video between
// them, and a song the listener uploaded.
const song = (id: string, catalog?: string) => ({
  id,
  type: "library-songs",
  attributes: {
    name: id,
    playParams: catalog ? { id, kind: "song", catalogId: catalog } : { id, kind: "song", isLibrary: true },
  },
});
const original = [
  song("i.a", "100"),
  { id: "i.v", type: "library-music-videos", attributes: { name: "video" } },
  song("i.b", "200"),
  song("i.up"),
];
// What Apple answers, which stays as it was until it catches up.
let answered = { name: "Mine", tracks: original, gone: false };
const asked: { method: string; path: string; body?: any }[] = [];
const json = (body: unknown) => Response.json(body);
globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  // Warming connections and working out the first songs to play aren't the playlist's.
  if (!url.pathname.startsWith("/v1/me/")) return new Response("", { status: 404 });
  if (method !== "GET") {
    asked.push({
      method,
      path: url.pathname + url.search,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(null, { status: 204 });
  }
  if (url.pathname === "/v1/me/library/playlists") {
    const lists = answered.gone
      ? []
      : [
          {
            id: "p.mine",
            type: "library-playlists",
            attributes: { name: answered.name, canEdit: true, lastModifiedDate: "2026-01-01" },
          },
        ];
    return json({ data: lists });
  }
  if (url.pathname === "/v1/me/library/playlists/p.mine") {
    return json({
      data: [{ id: "p.mine", type: "library-playlists", attributes: { name: answered.name, canEdit: true } }],
    });
  }
  if (url.pathname === "/v1/me/library/playlists/p.mine/tracks") return json({ data: answered.tracks });
  return new Response("", { status: 404 });
}) as typeof fetch;

const lib = await import("../src/library.ts");
const { playlist } = await import("../src/pages.ts");
const take = () => asked.splice(0);
const ids = async () => (await playlist({ id: "p.mine" })).tracks!.map((x) => x.id);

test("moving a song puts the whole new order, music videos where they were, and it reads back so", async () => {
  assert.deepEqual(await ids(), ["100", "200", "i.up"]);
  await lib.movePlaylistTrack({ id: "p.mine", from: 2, to: 0 });
  const [put] = take();
  assert.equal(put.method, "PUT");
  assert.equal(put.path, "/v1/me/library/playlists/p.mine/tracks");
  assert.deepEqual(
    put.body.data.map((x: { id: string }) => x.id),
    ["i.up", "i.v", "i.a", "i.b"],
  );
  // Apple still answers with the old order: the new one is what shows.
  assert.deepEqual(await ids(), ["i.up", "100", "200"]);
  // A move out of range is of a playlist changed elsewhere, and changes nothing.
  await assert.rejects(
    () => lib.movePlaylistTrack({ id: "p.mine", from: 5, to: 0 }),
    (e: { code?: string }) => e.code === "unsupported",
  );
  assert.equal(take().length, 0);
});

test("taking a song out goes by its library ID, every time it's listed, from the order last made", async () => {
  await lib.removeFromPlaylist({ id: "p.mine", trackIds: ["100"] });
  const [del] = take();
  assert.equal(del.method, "DELETE");
  assert.equal(del.path, "/v1/me/library/playlists/p.mine/tracks?ids%5Blibrary-songs%5D=i.a&mode=all");
  assert.deepEqual(await ids(), ["i.up", "200"]);
  // A song that isn't there is of a playlist changed elsewhere.
  await assert.rejects(
    () => lib.removeFromPlaylist({ id: "p.mine", trackIds: ["999"] }),
    (e: { code?: string }) => e.code === "unsupported",
  );
});

test("a new name shows at once, in the playlist and the list of them", async () => {
  await lib.renamePlaylist({ id: "p.mine", name: "Renamed" });
  assert.deepEqual(take(), [
    { method: "PATCH", path: "/v1/me/library/playlists/p.mine", body: { attributes: { name: "Renamed" } } },
  ]);
  assert.equal((await playlist({ id: "p.mine" })).name, "Renamed");
  assert.deepEqual(
    (await lib.playlists()).map((p) => p.name),
    ["Renamed"],
  );
});

test("songs added after an edit are Apple's to say", async () => {
  answered = { ...answered, tracks: [...original, song("i.c", "300")] };
  await lib.addToPlaylist({ id: "p.mine", trackIds: ["300"] });
  take();
  assert.deepEqual(await ids(), ["100", "200", "i.up", "300"]);
});

test("a deleted playlist is gone at once, though Apple still lists it", async () => {
  await lib.deletePlaylist({ id: "p.mine" });
  assert.deepEqual(take(), [{ method: "DELETE", path: "/v1/me/library/playlists/p.mine", body: undefined }]);
  assert.deepEqual(await lib.playlists(), []);
  await assert.rejects(
    () => playlist({ id: "p.mine" }),
    (e: { code?: string }) => e.code === "unavailable",
  );
});
