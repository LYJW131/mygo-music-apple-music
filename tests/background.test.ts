// What's fetched ahead: kept while good, shared with the app's own ask, and
// waiting while the app asks for something.

import assert from "node:assert/strict";
import { test } from "node:test";
import { foreground, forget, kept } from "../src/background.ts";

const tick = () => new Promise((r) => setTimeout(r, 10));

test("an answer is kept while its version is the one asked for, or for maxAge", async () => {
  let loads = 0;
  const load = async () => ++loads;
  assert.equal(await kept("a", { version: "1", maxAge: Infinity }, load), 1);
  assert.equal(await kept("a", { version: "1", maxAge: Infinity }, load), 1);
  assert.equal(await kept("a", { version: "2", maxAge: Infinity }, load), 2);
  assert.equal(await kept("b", { maxAge: 60_000 }, load), 3);
  assert.equal(await kept("b", { maxAge: 60_000 }, load), 3);
  assert.equal(await kept("b", { maxAge: 0 }, load), 4);
  forget("b");
  assert.equal(await kept("b", { maxAge: 60_000 }, load), 5);
});

test("a failed fetch isn't kept", async () => {
  let loads = 0;
  await assert.rejects(
    kept("c", { maxAge: 60_000 }, async () => Promise.reject(new Error(`no ${++loads}`))),
    /no 1/,
  );
  assert.equal(await kept("c", { maxAge: 60_000 }, async () => ++loads), 2);
});

test("what's forgotten while it's fetched isn't kept", async () => {
  let release!: () => void;
  const first = kept("d", { maxAge: 60_000 }, () => new Promise<string>((r) => (release = () => r("old"))));
  forget("d");
  release();
  assert.equal(await first, "old");
  assert.equal(await kept("d", { maxAge: 60_000 }, async () => "new"), "new");
});

test("the background waits while the app asks, and the app's ask joining it doesn't", async () => {
  let release!: () => void;
  const app = foreground(() => new Promise<void>((r) => (release = r)));
  const asking = app();
  const steps: string[] = [];
  const ahead = kept(
    "e",
    { maxAge: 60_000 },
    async (pause) => {
      steps.push("page 1");
      await pause();
      steps.push("page 2");
      return steps.length;
    },
    true,
  );
  await tick();
  assert.deepEqual(steps, ["page 1"], "went on while the app was asking");
  // The app asks for the same: it's shared, and no longer waits.
  const joined = kept("e", { maxAge: 60_000 }, async () => -1);
  release();
  await asking;
  assert.equal(await joined, 2);
  assert.equal(await ahead, 2);

  // Still in the background: it waits for the app, then a second more.
  const slow = foreground(() => new Promise<void>((r) => (release = r)));
  const busy = slow();
  let done = false;
  const later = kept("f", { maxAge: 60_000 }, async (pause) => (await pause(), (done = true)), true);
  await tick();
  release();
  await busy;
  await tick();
  assert.equal(done, false, "didn't wait for the app to be quiet");
  await later;
  assert.equal(done, true);
});
