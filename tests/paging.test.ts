// Paging through a list of the library: offline, against a stand-in for
// Apple that answers as Apple does, its next page's address saying the
// offset only, and notes how many pages were asked for at once.
import assert from "node:assert/strict";
import { test } from "node:test";

const jwt = `x.${btoa(JSON.stringify({ exp: Date.now() / 1000 + 86400 }))}.y`;
const storage = new Map<string, unknown>([
  ["devToken", jwt],
  ["mediaUserToken", "token"],
]);
(globalThis as any).host = {
  storage: {
    get: (k: string) => storage.get(k),
    set: (k: string, v: unknown) => void storage.set(k, v),
    remove: (k: string) => void storage.delete(k),
  },
  setting: () => "",
  t: (text: string) => text,
};

const TOTAL = 451;
let now = 0;
let most = 0;
let limits: number[] = [];
globalThis.fetch = (async (input: string | URL) => {
  const url = new URL(String(input));
  const offset = Number(url.searchParams.get("offset") ?? 0);
  // Without a limit Apple answers 25.
  const limit = Number(url.searchParams.get("limit") ?? 25);
  limits.push(limit);
  now++;
  most = Math.max(most, now);
  await new Promise((resolve) => setTimeout(resolve, 10));
  now--;
  const data = Array.from({ length: Math.max(0, Math.min(limit, TOTAL - offset)) }, (_, i) => ({
    id: `i.${offset + i}`,
    type: "library-songs",
  }));
  const next = offset + limit < TOTAL ? `${url.pathname}?offset=${offset + limit}` : undefined;
  return Response.json({ data, next, meta: { total: TOTAL } });
}) as typeof fetch;

const { allPages } = await import("../src/api.ts");
const { kept } = await import("../src/background.ts");

const fresh = () => {
  most = 0;
  limits = [];
};
const inOrder = (items: { id: string }[]) => items.every((x, i) => x.id === `i.${i}`);

test("the app's pages come a few at once, each as long as the first, all in order", async () => {
  fresh();
  const items = await allPages("/v1/me/library/songs", { limit: 100 }, 5000);
  assert.equal(items.length, TOTAL);
  assert.ok(inOrder(items));
  assert.equal(most, 3);
  assert.ok(
    limits.every((l) => l === 100),
    `limits asked: ${limits}`,
  );
  assert.equal(limits.length, 5);
});

test("in the background, one page at a time, pausing between them", async () => {
  fresh();
  let pauses = 0;
  const pause = async () => void pauses++;
  const items = await allPages("/v1/me/library/songs", { limit: 100 }, 5000, pause, () => false);
  assert.equal(items.length, TOTAL);
  assert.ok(inOrder(items));
  assert.equal(most, 1);
  assert.equal(pauses, 4);
});

test("a list fetched in the background that the app comes to ask for goes on a few pages at once", async () => {
  fresh();
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  // The background's fetch waits for the app after its first page...
  const load = (pause: () => Promise<void>, urgent: () => boolean) =>
    allPages("/v1/me/library/songs", { limit: 100 }, 5000, pause, urgent);
  const behind = kept("songs", { maxAge: 0 }, (pause, urgent) => load(() => pause().then(() => held), urgent), true);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(most, 1);
  // ...until the app asks for the same list.
  const asked = kept("songs", { maxAge: 0 }, load);
  release();
  assert.equal(await asked, await behind);
  assert.equal((await asked).length, TOTAL);
  assert.equal(most, 3);
});
