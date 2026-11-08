// Signing in as an account the wrapper holds, against a stand-in for amhelper
// and for Apple: the account named in the settings is the one signed in
// with, its token is asked for again as the wrapper refreshes it or Apple
// refuses it, and naming another account, or none, signs out of the old one.

import assert from "node:assert/strict";
import { mock, test } from "node:test";

const storage = new Map<string, unknown>();
const settings: Record<string, string> = { wrapper: "http://wrapper.example" };
const jwt = `e30.${Buffer.from(JSON.stringify({ exp: 4e9 })).toString("base64url")}.sig`;
storage.set("devToken", jwt);

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
  setting: (key) => settings[key] ?? "",
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

// The wrapper's accounts, by what names them, and their tokens; Apple
// accepts the tokens in accepted.
let tokens: Record<string, string> = { "a@example.com": "tokA1", "b@example.com": "tokB1" };
let next = 0;
let wrapperDown = false;
const accepted = new Set(["tokA1", "tokA2", "tokB1"]);
const asked: string[] = [];

mock.method(globalThis, "fetch", async (input: string | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.host === "127.0.0.1:1") {
    const named = url.searchParams.get("account") ?? "";
    asked.push(`token ${named}`);
    if (wrapperDown) throw new TypeError("fetch failed");
    if (!tokens[named]) {
      return Response.json(
        { code: "account", message: `the wrapper holds no account "${named}"; it holds a@example.com (US)` },
        { status: 404 },
      );
    }
    return Response.json({ token: tokens[named], region: "us", next, account: named });
  }
  // The web player, for a fresh developer token after a 401.
  if (url.host === "music.apple.com") {
    return new Response(url.pathname === "/" ? '<script src="/assets/index-1.js">' : "eyJhbGciOiJFUzI1NiJ9.e30.sig");
  }
  const user = (init?.headers as Record<string, string>)["media-user-token"];
  asked.push(`${url.pathname} ${user}`);
  if (!accepted.has(user)) return new Response("", { status: 401 });
  if (url.pathname === "/v1/me/storefront")
    return Response.json({ data: [{ id: user.startsWith("tokB") ? "jp" : "us" }] });
  if (url.pathname === "/v1/me/social-profile") return Response.json({ data: [{ attributes: { name: user } }] });
  if (url.pathname === "/v1/me/account") return Response.json({ data: [] });
  if (url.pathname === "/v1/me/library/songs") return Response.json({ data: [] });
  throw new Error(`unexpected fetch ${url}`);
});

const { account, signIn, signOut, retryWrapper } = await import("../src/account.ts");
const { me } = await import("../src/api.ts");

const reset = () => {
  asked.length = 0;
  retryWrapper();
};

test("the account named is signed in with, and the wrapper asked once", async () => {
  reset();
  settings.wrapperAccount = "a@example.com";
  next = Math.floor(Date.now() / 1000) + 1800;
  assert.equal((await account())?.name, "tokA1");
  assert.equal(storage.get("mediaUserToken"), "tokA1");
  await account();
  assert.deepEqual(
    asked.filter((a) => a.startsWith("token")),
    ["token a@example.com"],
  );
});

test("naming another account signs out of the first and in as it, forgetting what was kept", async () => {
  reset();
  settings.wrapperAccount = "b@example.com";
  const a = await account();
  assert.deepEqual(a && { id: a.id, name: a.name }, { id: "jp", name: "tokB1" });
  assert.equal(storage.get("mediaUserToken"), "tokB1");
});

test("naming none signs out, and a wrapper account named nowhere isn't signed in with", async () => {
  reset();
  settings.wrapperAccount = "";
  assert.equal(await account(), null);
  assert.equal(storage.has("mediaUserToken"), false);
  assert.equal(storage.has("wrapperAccount"), false);
  settings.wrapperAccount = "c@example.com";
  assert.equal(await account(), null);
  await assert.rejects(
    signIn(),
    (e: Error & { code?: string }) => e.code === "setup" && /c@example\.com/.test(e.message),
  );
});

test("signed out, the account stays signed out until signing in", async () => {
  reset();
  settings.wrapperAccount = "a@example.com";
  assert.equal((await account())?.name, "tokA1");
  signOut();
  assert.equal(await account(), null);
  assert.equal((await signIn())?.name, "tokA1");
});

test("a token given in the settings goes first", async () => {
  reset();
  settings.mediaUserToken = "tokB1";
  assert.equal((await account())?.id, "jp");
  assert.equal(storage.get("mediaUserToken"), "tokB1");
  assert.equal(storage.has("wrapperAccount"), false);
  settings.mediaUserToken = "";
  storage.delete("profile");
  assert.equal((await account())?.name, "tokA1");
});

test("a token Apple refuses is asked for again, and the request made again with the new one", async () => {
  reset();
  accepted.delete("tokA1");
  tokens = { ...tokens, "a@example.com": "tokA2" };
  await me("/library/songs");
  assert.equal(storage.get("mediaUserToken"), "tokA2");
  assert.deepEqual(asked.slice(-2), ["token a@example.com", "/v1/me/library/songs tokA2"]);
  // The wrapper giving the one refused again: log it in to the wrapper again.
  accepted.delete("tokA2");
  await assert.rejects(
    me("/library/songs"),
    (e: Error & { code?: string }) => e.code === "setup" && /wrapper/.test(e.message),
  );
  accepted.add("tokA2");
});

test("once the wrapper has refreshed the token, it's asked again, in the background", async () => {
  reset();
  storage.set("wrapperAccount", { ...(storage.get("wrapperAccount") as object), next: Date.now() - 1 });
  tokens = { ...tokens, "a@example.com": "tokA3" };
  accepted.add("tokA3");
  await me("/library/songs");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(storage.get("mediaUserToken"), "tokA3");
  assert.equal((storage.get("wrapperAccount") as { next: number }).next > Date.now() + 50_000, true);
});

test("a wrapper not answering isn't asked again within a minute, but signing in asks it", async () => {
  reset();
  settings.wrapperAccount = "b@example.com";
  wrapperDown = true;
  assert.equal(await account(), null);
  assert.equal(await account(), null);
  assert.deepEqual(asked, ["token b@example.com"]);
  wrapperDown = false;
  assert.equal((await signIn())?.id, "jp");
});
