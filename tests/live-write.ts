// Changes an account, against the real Apple Music: run only with
// APPLE_MUSIC_WRITE_TOKEN_FILE, on an account kept for testing, and puts back
// what it changes. Not part of npm test. Prints IDs and counts only: no
// names, nothing that says whose the account is.
//
// A playlist made for the test is edited and deleted: three songs added,
// renamed, the third moved to first, one taken out, each read back from Apple
// itself, past what the plugin answers of its own changes. Whatever happens,
// it's deleted at the end.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const file = process.env.APPLE_MUSIC_WRITE_TOKEN_FILE;
if (!file) throw new Error("Set APPLE_MUSIC_WRITE_TOKEN_FILE to a file holding a test account's media-user-token");
const storage = new Map<string, unknown>([["mediaUserToken", readFileSync(file, "utf8").trim()]]);
(globalThis as any).host = {
  platform: process.platform,
  arch: process.arch,
  dir: "/nonexistent",
  dataDir: "/nonexistent",
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

const { allPages, me, first } = await import("../src/api.ts");
const lib = await import("../src/library.ts");
const { playlist } = await import("../src/pages.ts");
const { search } = await import("../src/search.ts");
const { songID } = await import("../src/models.ts");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Asks Apple every 10 s, for up to 3 minutes, until ok says it has caught up. */
async function waitFor(what: string, ok: () => Promise<boolean>): Promise<void> {
  const t0 = Date.now();
  while (!(await ok())) {
    if (Date.now() - t0 > 3 * 60 * 1000) throw new Error(`Apple didn't show ${what} in 3 minutes`);
    await sleep(10_000);
  }
  console.log(`ok   ${what} (Apple read back after ${Math.round((Date.now() - t0) / 1000)} s)`);
}

/** What Apple says of the playlist, asked anew, past what the plugin keeps. */
async function apple(id: string) {
  const pl = first(await me(`/library/playlists/${id}`)).attributes ?? {};
  const tracks = await allPages(`/v1/me/library/playlists/${id}/tracks`, { limit: 100 }, 100).catch(() => []);
  return { name: pl.name ?? "", description: pl.description?.standard ?? "", songs: tracks.map(songID) };
}

const found = await search({ query: "taylor swift", kind: "tracks", offset: 0 });
const songs = [...new Set(found.tracks!.filter((x) => !x.unavailable).map((x) => x.id))].slice(0, 3);
assert.equal(songs.length, 3, "three songs to add");
console.log("songs", songs.join(", "));

const name = `[plugin test] playlist edits ${new Date().toISOString()}`;
const description = "Made by the plugin's tests/live-write.ts, and deleted by it.";
const made = first(
  await me("/library/playlists", null, { method: "POST", body: { attributes: { name, description } } }),
);
const id = made.id;
console.log("made", id);
let deleted = false;
try {
  const same = (want: string[]) => async () => JSON.stringify((await apple(id)).songs) === JSON.stringify(want);
  await lib.addToPlaylist({ id, trackIds: songs });
  await waitFor("three songs in it", same(songs));

  const renamed = `${name} (renamed)`;
  await lib.renamePlaylist({ id, name: renamed });
  assert.equal((await playlist({ id })).name === renamed, true, "the plugin answers with the new name at once");
  await waitFor("its new name", async () => (await apple(id)).name === renamed);
  assert.equal((await apple(id)).description, description, "renaming changed its description");

  await lib.movePlaylistTrack({ id, from: 2, to: 0 });
  assert.deepEqual(
    (await playlist({ id })).tracks!.map((x) => x.id),
    [songs[2], songs[0], songs[1]],
    "the plugin answers with the new order at once",
  );
  await waitFor("the third song first", same([songs[2], songs[0], songs[1]]));

  await lib.removeFromPlaylist({ id, trackIds: [songs[0]] });
  await waitFor("a song taken out", same([songs[2], songs[1]]));

  await lib.deletePlaylist({ id });
  deleted = true;
  assert.ok(!(await lib.playlists()).some((p) => p.id === id), "the plugin still lists it");
  await waitFor("it deleted", async () => {
    const lists = await allPages("/v1/me/library/playlists", { limit: 100 }, 500);
    return !lists.some((p) => p.id === id);
  });
} finally {
  if (!deleted) {
    await me(`/library/playlists/${id}`, null, { method: "DELETE" }).then(
      () => console.log("deleted the test's playlist"),
      (e: Error) => console.log(`FAIL deleting the test's playlist ${id}: ${e.message}`),
    );
  }
}
process.exit(0);
