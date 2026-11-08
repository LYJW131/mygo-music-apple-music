// Playing a song as AAC, against a stand-in for Apple and for amhelper: the
// song is handed over to amhelper with its key and length, and the app is
// given an address that names the song only. Nothing leaves this process.

import assert from "node:assert/strict";
import { mock, test } from "node:test";

const storage = new Map<string, unknown>();
const jwt = `e30.${Buffer.from(JSON.stringify({ exp: 4e9 })).toString("base64url")}.sig`;
storage.set("devToken", jwt);
storage.set("mediaUserToken", "user");
let spawned: string[] = [];

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
  setting: () => "",
  t: (text) => text,
  language: () => "en",
  removeDataDir: () => {},
  openURL: () => {},
  // amhelper, which says where it listens and then waits.
  spawn: (program) => {
    spawned.push(program);
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

const MEDIA = "https://aod-ssl.itunes.apple.com/itunes-assets/a/mzaf_1.rmhq.aac.wa.mp4";
const PLAYLIST = "https://aod-ssl.itunes.apple.com/itunes-assets/a/mzaf_1.rphq.aac.wa.m3u8";
const KEY_URI = `data:text/plain;base64,${Buffer.alloc(16, 7).toString("base64")}`;
const playlist = [
  "#EXTM3U",
  `#EXT-X-KEY:METHOD=SAMPLE-AES-CTR,KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed",URI="${KEY_URI}"`,
  `#EXT-X-MAP:URI="mzaf_1.rmhq.aac.wa.mp4",BYTERANGE="1006@0"`,
  "#EXTINF:9.98458,",
  "#EXT-X-BYTERANGE:342504@1006",
  "mzaf_1.rmhq.aac.wa.mp4",
  "#EXTINF:3.5,",
  "#EXT-X-BYTERANGE:1000@343510",
  "mzaf_1.rmhq.aac.wa.mp4",
].join("\n");

const asked: { url: string; body?: unknown }[] = [];
let helperAnswer = () => new Response('{"ok":true}');
mock.method(globalThis, "fetch", async (input: string | URL, init?: RequestInit) => {
  const url = String(input);
  asked.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
  if (url.startsWith("http://127.0.0.1:1/s/aac/")) return helperAnswer();
  if (url.includes("webPlayback")) {
    return Response.json({ songList: [{ assets: [{ flavor: "28:ctrp256", URL: PLAYLIST }] }] });
  }
  if (url === PLAYLIST) return new Response(playlist);
  throw new Error(`unexpected fetch ${url}`);
});

// The plugin reads what it kept once, as it starts.
storage.set("resolved", {
  "100": { m: MEDIA, k: "00".repeat(16), s: 200.5 },
  "101": { m: MEDIA, k: "11".repeat(16) },
  "102": { m: MEDIA, k: "22".repeat(16), s: 100 },
  "103": { m: MEDIA + "?old", k: "33".repeat(16), s: 100 },
});

const { stream } = await import("../src/playback.ts");

test("a song kept with its length is handed over to amhelper, and the app given its address", async () => {
  asked.length = 0;
  const s = await stream({ id: "100", quality: "high" });
  assert.deepEqual(s, { url: "http://127.0.0.1:1/s/aac/100.m4a", type: "m4a", quality: "high", bitRate: 256000 });
  assert.deepEqual(asked, [
    { url: "http://127.0.0.1:1/s/aac/100", body: { media: MEDIA, key: "00".repeat(16), seconds: 200.5 } },
  ]);
  assert.ok(!s.url.includes("00".repeat(16)), "the key is in the address");
  assert.deepEqual(spawned, ["bin/amhelper"]);
});

test("a song kept without its length has its playlist read again, and keeps its key", async () => {
  asked.length = 0;
  await stream({ id: "101", quality: "high" });
  assert.deepEqual(
    asked.map((a) => a.url.replace(/\?.*/, "")),
    ["https://play.music.apple.com/WebObjects/MZPlay.woa/wa/webPlayback", PLAYLIST, "http://127.0.0.1:1/s/aac/101"],
    "a license was asked for",
  );
  assert.deepEqual(asked[2].body, { media: MEDIA, key: "11".repeat(16), seconds: 13.48458 });
  assert.deepEqual((storage.get("resolved") as Record<string, unknown>)["101"], {
    m: MEDIA,
    k: "11".repeat(16),
    s: 13.48458,
  });
});

test("amhelper failing on a song is an error, not a song asked for afresh or played through ffmpeg", async () => {
  helperAnswer = () => Response.json({ code: "failed", message: "boom" }, { status: 502 });
  spawned = [];
  asked.length = 0;
  await assert.rejects(stream({ id: "102", quality: "high" }), /amhelper: boom/);
  assert.deepEqual(spawned, [], "a program was started");
  assert.equal(asked.length, 1, "the song was asked for afresh");
  helperAnswer = () => new Response('{"ok":true}');
});

test("a kept song whose file Apple no longer has is asked for afresh", async () => {
  helperAnswer = () => Response.json({ code: "media", message: "media: HTTP 404" }, { status: 502 });
  asked.length = 0;
  // The stand-in has no license server: the request for one ends it.
  await assert.rejects(stream({ id: "103", quality: "high" }), /unexpected fetch .*acquireWebPlaybackLicense/);
  assert.ok(asked.some((a) => a.url.includes("webPlayback")));
  assert.equal((storage.get("resolved") as Record<string, unknown>)["103"], undefined);
  helperAnswer = () => new Response('{"ok":true}');
});
