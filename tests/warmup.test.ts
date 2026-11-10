// What's fetched ahead of the library, asked for by the app while it waits
// for the app: offline, against a stand-in for Apple that answers every list
// with one thing and a next page, so that each fetch pauses between pages.
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

let asked = 0;
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
  asked++;
  if (init?.method === "HEAD") return new Response(null);
  const url = new URL(String(input));
  const offset = Number(url.searchParams.get("offset") ?? 0);
  // Two pages of whatever is asked for, named for the path's last part.
  const type = url.pathname.split("/").pop() || "songs";
  return json({
    data: [
      { id: `${type}.${offset}`, type, attributes: { name: `${type} ${offset}`, canEdit: false, canDelete: false } },
    ],
    next: offset === 0 ? `${url.pathname}?offset=100` : undefined,
    meta: { total: 101 },
  });
}) as typeof fetch;

const { foreground, forgetAll } = await import("../src/background.ts");
const { AHEAD } = await import("../src/warmup.ts");

const settled = (p: Promise<unknown>) =>
  Promise.race([
    p.then(
      () => "answered",
      () => "answered",
    ),
    new Promise<string>((r) => setTimeout(() => r("stuck"), 4000)),
  ]);

// 0.3.3's Stations page never opened: the stations were being fetched ahead
// and had paused because the app was asking for its first pages, the app
// then asked for the stations, and the pause waited for that ask to end.
// Fetching the library a hundred at a time had brought the stations' turn
// forward into the app's first seconds. Every step of the warm-up is asked
// for the same way here, so one added later is covered too.
test("each thing fetched ahead answers the app that asks for it while it waits for the app", async () => {
  assert.ok(AHEAD.length >= 5, "the warm-up's steps aren't the ones this walks");
  for (const [i, step] of AHEAD.entries()) {
    forgetAll();
    // The app is asking for something else, so what's fetched ahead waits.
    let release!: () => void;
    const busy = foreground(() => new Promise<void>((r) => (release = r)))();
    const before = asked;
    const ahead = step(true);
    ahead.catch(() => {});
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(asked > before, `step ${i} asked Apple for nothing`);
    // The app asks for the very thing, as it calls the plugin.
    const own = foreground(() => step(false))();
    own.catch(() => {});
    assert.equal(await settled(own), "answered", `step ${i}: the app's ask for it never ended`);
    release();
    await busy;
    assert.equal(await settled(ahead), "answered", `step ${i}: what was fetched ahead never ended`);
  }
});
