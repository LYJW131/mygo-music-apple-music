// The listener's own playlists, as Apple's Recently Played gives them, by
// their catalog ID: offline, against a stand-in for Apple.
import assert from "node:assert/strict";
import { test } from "node:test";

// A developer token that runs out in a day, and a listener signed in.
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

// Their own playlist, and one they saved from someone else, in the library
// and by the catalog IDs they're shared under.
const library: Record<string, { canEdit: boolean; catalog: string }> = {
  "p.mine": { canEdit: true, catalog: "pl.u-mine" },
  "p.theirs": { canEdit: false, catalog: "pl.u-theirs" },
  "p.down": { canEdit: false, catalog: "pl.u-down" }, // the library doesn't answer
};
const deleted: string[] = [];
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname;
  if (init?.method === "HEAD") return new Response(null);
  let m = path.match(/^\/v1\/me\/library\/playlists\/(p\.\w+)(\/tracks)?$/);
  if (m) {
    if (init?.method === "DELETE") {
      deleted.push(m[1]);
      return new Response(null, { status: 204 });
    }
    if (m[2]) return new Response("", { status: 404 }); // no songs
    if (m[1] === "p.down") return new Response("", { status: 503 });
    const p = library[m[1]];
    return json({ data: [{ id: m[1], type: "library-playlists", attributes: { name: m[1], canEdit: p.canEdit } }] });
  }
  m = path.match(/^\/v1\/catalog\/us\/playlists\/(pl\.[\w-]+)$/);
  if (m) {
    const lib = Object.entries(library).find(([, p]) => p.catalog === m![1])?.[0];
    return json({
      data: [
        {
          id: m[1],
          type: "playlists",
          attributes: { name: m[1] },
          relationships: {
            tracks: { data: [] },
            library: { data: lib ? [{ id: lib, type: "library-playlists" }] : [] },
          },
        },
      ],
    });
  }
  return new Response("", { status: 404 });
}) as typeof fetch;

const { playlist } = await import("../src/pages.ts");
const { savePlaylist } = await import("../src/library.ts");

test("their own playlist by its catalog ID opens as theirs, not as one they saved", async () => {
  const own = await playlist({ id: "pl.u-mine" });
  assert.equal(own.id, "p.mine");
  assert.equal(own.mine, true);
  assert.equal(own.saved, false);

  const saved = await playlist({ id: "pl.u-theirs" });
  assert.equal(saved.id, "pl.u-theirs");
  assert.equal(saved.mine, false);
  assert.equal(saved.saved, true);

  // Without an answer from the library, the playlist still opens, from the catalog.
  const down = await playlist({ id: "pl.u-down" });
  assert.equal(down.id, "pl.u-down");
  assert.equal(down.saved, true);
});

test("unsaving never deletes a playlist they made", async () => {
  for (const id of ["pl.u-mine", "p.mine"]) {
    await assert.rejects(
      () => savePlaylist({ id, on: false }),
      (e: { code?: string }) => e.code === "unsupported",
    );
  }
  assert.deepEqual(deleted, []);
  await savePlaylist({ id: "pl.u-theirs", on: false });
  assert.deepEqual(deleted, ["p.theirs"]);
});
