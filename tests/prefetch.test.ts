// What the wrapper is asked while songs play lossless, against a stand-in for
// amhelper: nothing once the songs coming up are worked out, so that a wrapper
// on Cloudflare can sleep. Simulated time, nothing leaves this process.

import assert from "node:assert/strict";
import { mock, test } from "node:test";

const storage = new Map<string, unknown>();
const asked: { url: string; at: number }[] = [];

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
  // amhelper, which says where it listens and then waits.
  spawn: () => {
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

// Everything the plugin fetches. amhelper answers; Apple isn't there.
globalThis.fetch = async (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input);
  asked.push({ url, at: Date.now() });
  if (url.includes("/prepare/")) return Response.json({ sampleRate: 44100, bitDepth: 16, bandwidth: 1000000 });
  if (url.includes("/wake")) return Response.json({ woke: true });
  if (url.includes("/find/")) return Response.json({});
  return new Response("not here", { status: 404 });
};

mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.parse("2026-11-08T04:00:00Z") });

const { noteAudio } = await import("../src/lossless.ts");
const { prefetch } = await import("../src/prefetch.ts");
const api = await import("../src/index.ts");

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};
const minutes = async (n: number) => {
  for (let left = n * 60_000; left > 0; left -= 10_000) {
    mock.timers.tick(Math.min(left, 10_000));
    await settle();
  }
};
const toWrapper = () => asked.filter((x) => /\/(wake|prepare|find)\b/.test(x.url)).map((x) => x.url);
const tracks = (ids: string[]) =>
  ids.map((id) => ({ id, name: id }) as unknown as Parameters<typeof prefetch>[0][number]);
const lossless = (yes = true) => ({ audioTraits: yes ? ["lossless"] : [], extendedAssetUrls: {} });

// The listener chose Lossless before.
storage.set("quality", "lossless");

// An album the listener played before: every song is worked out, kept from then.
const album = Array.from({ length: 20 }, (_, i) => String(1000 + i));
storage.set(
  "lossless",
  Object.fromEntries(
    album.map((id) => [id, { q: { sampleRate: 44100, bitDepth: 16, bandwidth: 1000000, query: "" }, at: Date.now() }]),
  ),
);
for (const id of album) noteAudio(id, lossless() as never);

test("browsing, the wrapper is woken ahead of the first song", async () => {
  await api.stations({});
  await settle();
  assert.deepEqual(toWrapper(), ["http://127.0.0.1:1/s/wake"]);
});

test("playing songs worked out before, the wrapper isn't asked anything for six minutes", async () => {
  await minutes(1);
  asked.length = 0;
  prefetch(tracks(album));
  // A song every three minutes, and the app asking for other things between.
  for (const id of album.slice(0, 2)) {
    const s = await api.stream({ id, quality: "lossless" });
    assert.equal(s.quality, "lossless");
    for (let i = 0; i < 6; i++) {
      await minutes(0.5);
      await api.stations({});
      await settle();
    }
  }
  assert.deepEqual(toWrapper(), []);
});

test("songs stopped for a while, browsing wakes it again", async () => {
  await minutes(11);
  await api.stations({});
  await settle();
  assert.deepEqual(toWrapper(), ["http://127.0.0.1:1/s/wake"]);
});

// A playlist never played: playing one song works out the ones after it.
const playlist = Array.from({ length: 40 }, (_, i) => String(2000 + i));
for (const id of playlist) noteAudio(id, lossless() as never);
const prepared = () =>
  asked
    .filter((x) => x.url.includes("/prepare/"))
    .map((x) => ({ id: x.url.match(/prepare\/(\d+)/)![1], ahead: x.url.includes("ahead=1"), at: x.at }));

test("playing a song works out the twelve after it, one after the other", async () => {
  await minutes(2);
  prefetch(tracks(playlist));
  await settle();
  // The page's first three, as before.
  assert.deepEqual(
    prepared().map((x) => x.id),
    ["2000", "2001", "2002"],
  );
  asked.length = 0;
  await api.stream({ id: "2004", quality: "lossless" });
  await settle();
  assert.deepEqual(prepared(), [
    { id: "2004", ahead: false, at: prepared()[0].at },
    ...playlist.slice(5, 17).map((id) => ({ id, ahead: true, at: prepared()[0].at })),
  ]);
});

test("with the next three worked out, playing asks the wrapper nothing", async () => {
  asked.length = 0;
  for (const id of ["2005", "2006", "2007"]) {
    await api.stream({ id, quality: "lossless" });
    await minutes(3);
  }
  assert.deepEqual(toWrapper(), []);
});

test("more than fifteen songs a minute wait for the minute to pass", async () => {
  asked.length = 0;
  const from = Date.now();
  await api.stream({ id: "2014", quality: "lossless" }); // 2015, 2016 are worked out, 2017 isn't
  await settle();
  await api.stream({ id: "2026", quality: "lossless" }); // and 2027 to 2038
  await settle();
  const ahead = () => prepared().filter((x) => x.ahead);
  assert.equal(ahead().length, 15);
  await minutes(0.9);
  assert.equal(ahead().length, 15);
  await minutes(0.2);
  assert.equal(ahead().length, 22); // 2017 to 2038
  for (const [i, x] of ahead().entries()) {
    if (i >= 15) assert.ok(x.at - ahead()[i - 15].at >= 60_000, `${x.id} too soon`);
  }
  assert.ok(ahead().every((x) => x.at - from < 2 * 60_000));
});
