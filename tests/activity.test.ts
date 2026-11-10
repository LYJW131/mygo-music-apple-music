// Plays reported to Apple's activity service as the web player reports them:
// offline, against a stand-in that keeps what it was sent.
import assert from "node:assert/strict";
import { test } from "node:test";

const jwt = `x.${btoa(JSON.stringify({ exp: Date.now() / 1000 + 86400 }))}.y`;
const storage = new Map<string, unknown>([
  ["devToken", jwt],
  ["mediaUserToken", "token"],
  ["storefront", "jp"],
]);
const settings: Record<string, string> = {};
(globalThis as any).host = {
  storage: {
    get: (k: string) => storage.get(k),
    set: (k: string, v: unknown) => void storage.set(k, v),
    remove: (k: string) => void storage.delete(k),
  },
  setting: (k: string) => settings[k] ?? "",
  t: (text: string) => text,
};

interface Sent {
  headers: Headers;
  body: { client_id: string; event_type: string; data: Record<string, any>[] };
}
let sent: Sent[] = [];
let lookups: string[] = [];
globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  // A song the app never listed: its length comes from the catalog, slowly.
  const song = url.pathname.match(/^\/v1\/catalog\/jp\/songs\/(\d+)$/);
  if (song) {
    lookups.push(song[1]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    return new Response(
      JSON.stringify({ data: [{ id: song[1], type: "songs", attributes: { durationInMillis: 300000 } }] }),
    );
  }
  assert.equal(String(input), "https://universal-activity-service.itunes.apple.com/play");
  assert.equal(init?.method, "POST");
  sent.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
  return new Response("{}", { headers: { "content-type": "application/json" } });
}) as typeof fetch;

const { played, noteDuration } = await import("../src/activity.ts");

const take = () => {
  const out = sent;
  sent = [];
  return out;
};

// Every event sent, in order, each in a request of its own.
const events = () => {
  const out = take();
  for (const r of out) assert.equal(r.body.data.length, 1, "one event to a request");
  return out.map((r) => r.body.data[0]);
};

test("a song's start is sent as it plays, as the web player sends it, and its end before the next one's start", async () => {
  noteDuration("1783644617", 256613);
  await played({ id: "1783644617" });
  const [req, ...more] = take();
  assert.equal(more.length, 0);
  assert.equal(req.headers.get("authorization"), `Bearer ${jwt}`);
  assert.equal(req.headers.get("media-user-token"), "token");
  assert.equal(req.body.client_id, "JSCLIENT");
  assert.equal(req.body.event_type, "JSPLAY");
  assert.equal(req.body.data.length, 1);
  const start = req.body.data[0];
  assert.equal(start["event-type"], 1);
  assert.deepEqual(start.ids, { "subscription-adam-id": "1783644617" });
  assert.equal(start["media-duration-in-milliseconds"], 256613);
  assert.equal(start["store-front"], "jp");
  assert.equal(start["source-type"], 16);
  assert.match(start["build-version"], /^AppleMusic\/1\.0 macOS\/10\.15\.7 model\/MacIntel build\//);
  assert.match(start["persistent-id"], /^[0-9a-f]{16}$/);
  assert.equal(start["event-reason-hint-type"], 0);
  assert.equal(start["internal-build"], false);
  assert.equal(start["feature-name"], "music_kit-integration");
  assert.equal(typeof start["milliseconds-since-play"], "number");
  for (const gone of ["guid", "device-name", "timestamp"]) assert.equal(gone in start, false, gone);

  // Skipped a moment later: the end says so, and the next song starts.
  await played({ id: "1880587625" });
  const [end, next] = events();
  assert.equal(end["event-type"], 0);
  assert.deepEqual(end.ids, { "subscription-adam-id": "1783644617" });
  assert.equal(end["end-reason-type"], 2);
  assert.equal(end["end-position-in-milliseconds"], 0, "in whole seconds");
  assert.equal("event-reason-hint-type" in end, false);
  assert.equal(next["event-type"], 1);
  assert.deepEqual(next.ids, { "subscription-adam-id": "1880587625" });
  assert.equal(next["media-duration-in-milliseconds"], 300000, "never listed: looked up");
  assert.deepEqual(lookups, ["1880587625"]);
  assert.notEqual(end["persistent-id"], next["persistent-id"]);
});

test("a song played out ends naturally, at its length", async () => {
  noteDuration("1", 1);
  await played({ id: "1" });
  take();
  await new Promise((resolve) => setTimeout(resolve, 5));
  await played({ id: "i.upload" });
  const sent = events();
  assert.equal(sent.length, 1, "a song outside the catalog isn't reported");
  assert.equal(sent[0]["end-reason-type"], 7);
  assert.equal(sent[0]["end-position-in-milliseconds"], 1);
  await played({ id: "i.upload" });
  assert.equal(take().length, 0);
});

test("off in the setting, or signed out, sends nothing", async () => {
  await played({ id: "1783644617" });
  take();
  settings.listeningHistory = " OFF ";
  await played({ id: "1880587625" });
  assert.equal(take().length, 0);
  settings.listeningHistory = "";
  await played({ id: "1783644617" });
  assert.equal(events().length, 1, "nothing left over from before it was off");

  storage.delete("mediaUserToken");
  await played({ id: "1880587625" });
  assert.equal(take().length, 0);
  storage.set("mediaUserToken", "token");
});

test("plays close together each end the one just before them, in the order they came", async () => {
  await played({ id: "1783644617" });
  take();
  // The first waits on the catalog for its length while the next starts.
  await Promise.all([played({ id: "1001" }), played({ id: "1783644617" })]);
  await played({ id: "1880587625" });
  assert.deepEqual(
    events().map((e) => `${e["event-type"] ? "start" : "end"} ${e.ids["subscription-adam-id"]}`),
    ["end 1783644617", "start 1001", "end 1001", "start 1783644617", "end 1783644617", "start 1880587625"],
  );
});

test("a song on an album or playlist page opened is reported as played from it, and a change of it so", async () => {
  const { listed } = await import("../src/prefetch.ts");
  const song = (id: string) => ({ id, name: id, album: { id: "", name: "" }, duration: 1000 });
  listed([song("11"), song("12")], undefined, {
    type: 3,
    ids: { "album-adam-id": "10" },
    feature: "new / album_detail",
  });
  listed([song("21"), song("12")], undefined, { type: 2, ids: { "universal-library-id": "p.x" } });
  await played({ id: "11" });
  await played({ id: "12" });
  await played({ id: "11" });
  await played({ id: "1880587625" });
  const sent = events();
  const start11 = sent.find((e) => e["event-type"] === 1 && e.ids["subscription-adam-id"] === "11")!;
  assert.equal(start11["container-type"], 3);
  assert.deepEqual(start11["container-ids"], { "album-adam-id": "10" });
  assert.equal(start11["feature-name"], "new / album_detail");
  assert.equal(start11["event-reason-hint-type"], 1);
  // 12 is on both pages: the playlist's, opened last, is where it's played from.
  const [, , end11, start12, end12, again11, end11b, none] = sent;
  assert.equal(end11["end-reason-type"], 5, "the next is played from another container");
  assert.deepEqual(start12["container-ids"], { "universal-library-id": "p.x" });
  assert.equal(start12["container-type"], 2);
  assert.equal(start12["feature-name"], "music_kit-integration");
  assert.deepEqual(end12["container-ids"], { "universal-library-id": "p.x" }, "an end is of where it played from");
  assert.equal(again11["event-reason-hint-type"], 1);
  // A song on no page opened says no container, and the end before it is a skip.
  assert.equal(end11b["end-reason-type"], 2);
  assert.equal(none["container-type"], 0);
  assert.equal("container-ids" in none, false);
  assert.equal(none["event-reason-hint-type"], 0);
});
