// Every way the app gets songs it may play, signed in and lossless, against
// a stand-in for Apple and for amhelper: playing one works out the songs after
// it, and once they're worked out the wrapper is asked nothing, so that on
// Cloudflare it sleeps. Simulated time, nothing leaves this process.

import assert from "node:assert/strict";
import { mock, test } from "node:test";

const storage = new Map<string, unknown>();
const asked: { url: string; at: number }[] = [];
// Every song amhelper was asked to work out, since the start.
const workedOut = new Set<string>();

(globalThis as { host?: Host }).host = {
  platform: "linux",
  arch: "x64",
  dir: "/plugin",
  dataDir: "/data",
  storage: {
    get: <T>(k: string) => (storage.has(k) ? (structuredClone(storage.get(k)) as T) : undefined),
    set: (k, v) => void storage.set(k, structuredClone(v)),
    remove: (k) => void storage.delete(k),
  },
  setting: (key) => (key === "wrapper" ? "https://wrapper.example" : ""),
  t: (text) => text,
  language: () => "en",
  removeDataDir: () => {},
  openURL: () => {},
  // amhelper, which says where it listens and then waits; ffmpeg isn't there.
  spawn: (program) => {
    if (!program.includes("amhelper")) throw new Error("no such program");
    let said = false;
    return {
      pid: 1,
      write: () => {},
      closeStdin: () => {},
      readLine: () =>
        said ? new Promise<null>(() => {}) : ((said = true), Promise.resolve('{"port":1,"secret":"s"}')),
      wait: () => new Promise<number>(() => {}),
      kill: () => {},
      errorOutput: () => "",
    };
  },
};

// A song of the catalog, lossless, as Apple lists it.
const song = (id: string) => ({
  id,
  type: "songs",
  attributes: {
    name: `Song ${id}`,
    playParams: { id, kind: "song" },
    audioTraits: ["lossless"],
    extendedAssetUrls: { enhancedHls: `https://aod.itunes.apple.com/${id}.m3u8` },
  },
});
const songs = (from: number, n: number) => Array.from({ length: n }, (_, i) => song(String(from + i)));
const ids = (from: number, n: number) => Array.from({ length: n }, (_, i) => String(from + i));

// What Apple has: the paths the plugin asks for, without the storefront's prefix.
let stationBatch = 0;
let recentFrom = 1100;
const apple: [RegExp, (u: URL) => unknown][] = [
  [/^\/v1\/catalog\/us\/charts$/, () => ({ results: { songs: [{ name: "Top Songs", data: songs(1000, 30) }] } })],
  [/^\/v1\/me\/recommendations$/, () => ({ data: [] })],
  [/^\/v1\/me\/recent\/played\/tracks$/, () => ({ data: songs(recentFrom, 10) })],
  [
    /^\/v1\/catalog\/us\/albums\/(\d+)$/,
    (u) => {
      const id = u.pathname.split("/").pop()!;
      const from = id === "800" ? 1200 : 1500;
      if (u.searchParams.get("relate")) return { data: [{ id, type: "albums" }] };
      return {
        data: [{ id, type: "albums", attributes: { name: id }, relationships: { tracks: { data: songs(from, 20) } } }],
      };
    },
  ],
  [
    /^\/v1\/catalog\/us\/artists\/900$/,
    () => ({
      data: [
        { id: "900", type: "artists", attributes: { name: "X" }, views: { "top-songs": { data: songs(1300, 20) } } },
      ],
    }),
  ],
  [
    /^\/v1\/catalog\/us\/playlists\/pl\.1$/,
    (u) =>
      u.searchParams.get("relate")
        ? { data: [{ id: "pl.1", type: "playlists" }] }
        : {
            data: [
              {
                id: "pl.1",
                type: "playlists",
                attributes: { name: "P" },
                relationships: { tracks: { data: songs(1400, 20) } },
              },
            ],
          },
  ],
  [
    /^\/v1\/me\/library\/playlists$/,
    () => ({
      data: [{ id: "p.fav", type: "library-playlists", attributes: { name: "Favorite Songs", canDelete: false } }],
    }),
  ],
  [/^\/v1\/me\/library\/playlists\/p\.fav\/tracks$/, () => ({ data: songs(1600, 20) })],
  [
    /^\/v1\/catalog\/us\/search$/,
    (u) => {
      const offset = Number(u.searchParams.get("offset") ?? 0);
      return { results: { songs: { data: songs(1700 + offset, 25), next: offset < 25 ? "/next" : undefined } } };
    },
  ],
  [
    /^\/v1\/me\/stations\/next-tracks\/ra\.1$/,
    () => {
      const from = 3000 + 10 * stationBatch++;
      return { data: songs(from, 10) };
    },
  ],
  [/^\/v1\/me\/ratings\/songs$/, () => ({ data: [] })],
  [/^\/v1\/me\/library\/playlists\/p\.fav$/, () => ({ data: [{ id: "p.fav", type: "library-playlists" }] })],
  [/^\/v1\/catalog\/us\/songs$/, (u) => ({ data: (u.searchParams.get("ids") ?? "").split(",").map(song) })],
];

globalThis.fetch = async (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input);
  asked.push({ url, at: Date.now() });
  const u = new URL(url);
  if (u.hostname === "127.0.0.1") {
    if (u.pathname.includes("/prepare/")) workedOut.add(u.pathname.split("/").pop()!);
    if (u.pathname.includes("/prepare/")) {
      return Response.json({ sampleRate: 44100, bitDepth: 16, bandwidth: 1000000, loudness: {} });
    }
    if (u.pathname.endsWith("/wake")) return Response.json({ woke: true });
    if (u.pathname.includes("/find/")) return Response.json({});
  }
  if (u.hostname === "amp-api.music.apple.com") {
    for (const [path, answer] of apple) if (path.test(u.pathname)) return Response.json(answer(u));
  }
  return new Response("{}", { status: 404 });
};

mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.parse("2026-11-08T04:00:00Z") });

// Signed in, with a developer token that's good for a year, and Lossless chosen before.
const exp = Math.floor(Date.now() / 1000) + 365 * 86400;
storage.set("devToken", `eyJhbGciOiJFUzI1NiJ9.${btoa(JSON.stringify({ exp })).replace(/=+$/, "")}.sig`);
storage.set("mediaUserToken", "token");
storage.set("storefront", "us");
storage.set("quality", "lossless");

const api = await import("../src/index.ts");
const { libraryPlaylist } = await import("../src/pages.ts");
const { liked } = await import("../src/library.ts");
const { stations } = await import("../src/stations.ts");

const settle = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
};
const minutes = async (n: number) => {
  for (let left = n * 60_000; left > 0; left -= 10_000) {
    mock.timers.tick(Math.min(left, 10_000));
    await settle();
  }
};

// What reaches the wrapper: a song's keys, and waking it.
const toWrapper = () => asked.filter((x) => /\/s\/(wake|prepare)\b/.test(x.url));
const prepared = () =>
  asked
    .filter((x) => x.url.includes("/s/prepare/"))
    .map((x) => ({ id: x.url.match(/prepare\/(\d+)/)![1], ahead: x.url.includes("ahead=1") }));

/** Plays songs as the app does: the audio of the one starting, its lyrics, and the next one's audio ahead. */
async function play(list: string[], from: number, n: number, each = 3.5) {
  for (let i = from; i < from + n; i++) {
    if (i === from) await api.stream({ id: list[i], quality: "lossless" });
    await api.lyrics({ id: list[i] });
    if (list[i + 1]) await api.stream({ id: list[i + 1], quality: "lossless" });
    await settle();
    // The app asks other things while it plays.
    await minutes(each / 2);
    await api.isLiked({ ids: [list[i]] });
    await minutes(each / 2);
  }
}

/** Opens a page, plays its song at, and checks the twelve after are worked out, then nothing more. */
async function playsOn(list: string[], at: number) {
  await minutes(11); // nothing played for a while, and the minute's limit is clear
  await settle();
  // A page the listener opens has its first three worked out as it opens.
  const before = new Set(workedOut);
  asked.length = 0;
  await api.stream({ id: list[at], quality: "lossless" });
  await settle();
  assert.deepEqual(
    prepared(),
    [{ id: list[at], ahead: false }, ...list.slice(at + 1, at + 13).map((id) => ({ id, ahead: true }))].filter(
      (x) => !before.has(x.id),
    ),
  );
  asked.length = 0;
  await play(list, at + 1, 8);
  assert.deepEqual(toWrapper(), [], "nothing for the wrapper while the songs worked out play");
}

test("home: its songs are noted, not worked out, and play on", async () => {
  await minutes(1);
  asked.length = 0;
  await api.home({});
  await settle();
  assert.deepEqual(prepared(), [], "home, which the app loads again by itself, works nothing out");
  await playsOn(ids(1000, 30), 2);
});

test("home's Recently Played: plays on", async () => {
  await api.home({});
  // Ten songs here: the twelve after the first are nine.
  await playsOn(ids(1100, 10), 0);
});

test("recent: plays on", async () => {
  recentFrom = 1150;
  await api.recent({});
  await playsOn(ids(1150, 10), 0);
});

test("the charts: play on", async () => {
  await api.browse({ page: "charts" });
  await playsOn(ids(1000, 30), 15);
});

test("an album: plays on", async () => {
  await api.album({ id: "800" });
  await playsOn(ids(1200, 20), 1);
});

test("an artist's top songs: play on", async () => {
  await api.artist({ id: "900" });
  await playsOn(ids(1300, 20), 0);
});

test("a playlist: plays on", async () => {
  await api.playlist({ id: "pl.1" });
  await playsOn(ids(1400, 20), 3);
});

test("liked: plays on", async () => {
  await api.liked({});
  await playsOn(ids(1600, 20), 0);
});

test("a search, into its next page: plays on", async () => {
  await api.search({ query: "x", kind: "tracks" });
  await api.search({ query: "x", kind: "tracks", offset: 25 });
  await playsOn(ids(1700, 50), 20);
});

test("a song on a page the listener opened stays on it when home comes again", async () => {
  await api.album({ id: "801" });
  await api.home({}); // Recently Played, here 1100 to 1109, isn't 1500's
  await minutes(11);
  asked.length = 0;
  await api.stream({ id: "1505", quality: "lossless" });
  await settle();
  assert.deepEqual(
    prepared().map((x) => x.id),
    ids(1505, 13),
  );
});

test("fetched in the background, nothing goes to the wrapper", async () => {
  await minutes(11);
  asked.length = 0;
  await liked({ offset: 0 }, true);
  await libraryPlaylist("p.fav", true);
  await stations(undefined, true);
  await settle();
  assert.deepEqual(toWrapper(), []);
});

test("songs the app plays from its cache: their lyrics say they play, and the wrapper sleeps", async () => {
  await minutes(11);
  await api.stations({}); // browsing, which wakes it
  await settle();
  assert.equal(toWrapper().filter((x) => x.url.endsWith("/wake")).length, 1);
  await api.lyrics({ id: "1200" }); // a song starts, from the app's cache
  asked.length = 0;
  for (let i = 0; i < 10; i++) {
    await minutes(4);
    await api.lyrics({ id: String(1201 + i) });
    await api.isLiked({ ids: [String(1201 + i)] });
    await api.home({});
  }
  await settle();
  assert.deepEqual(toWrapper(), []);
});

test("a station: each ten songs are worked out as they come, and the wrapper sleeps between", async () => {
  await minutes(11);
  asked.length = 0;
  const station = await api.stationNext({ id: "ra.1" });
  let queue = station.map((t) => t.id);
  await settle();
  // All ten, the first as it plays.
  await api.stream({ id: queue[0], quality: "lossless" });
  await settle();
  assert.deepEqual(new Set(prepared().map((x) => x.id)), new Set(ids(3000, 10)));
  // Three batches, played as the app plays them: it asks for the next ten
  // as the last but one starts, and plays on into them.
  for (let at = 0; at < 28; at++) {
    if (at === queue.length - 2) {
      const more = await api.stationNext({ id: "ra.1" });
      queue = queue.concat(more.map((t) => t.id));
    }
    await api.lyrics({ id: queue[at] });
    if (at + 1 < queue.length) await api.stream({ id: queue[at + 1], quality: "lossless" });
    await settle();
    await minutes(1.75);
    await api.isLiked({ ids: [queue[at]] });
    await minutes(1.75);
  }
  const keys = prepared();
  assert.deepEqual([...new Set(keys.filter((x) => x.ahead).map((x) => x.id))].sort(), ids(3000, 30));
  // What the wrapper was asked, by when: three bursts, half an hour apart.
  const at = toWrapper().map((x) => x.at);
  const gaps = at.slice(1).map((t, i) => t - at[i]);
  const long = gaps.filter((g) => g >= 5 * 60_000);
  assert.equal(long.length, 2, `gaps: ${gaps.map((g) => Math.round(g / 1000)).join(", ")} s`);
  assert.ok(long.every((g) => g >= 25 * 60_000));
  // Woken once, as the listener picked the station, and not again.
  assert.equal(toWrapper().filter((x) => x.url.endsWith("/wake")).length, 1);
  assert.equal(toWrapper()[0].url, "http://127.0.0.1:1/s/wake");
});
