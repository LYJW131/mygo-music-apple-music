// Work done while the listener isn't waiting on the plugin: what they keep in
// their library is fetched ahead (warmup.ts), so that their playlists, their
// favorites and their albums open at once. It waits whenever the app is
// asking for something, and a second after, and goes one request at a time.

import { sleep } from "./util.ts";

let asking = 0;
let lastAsked = 0;
const QUIET = 1000;

/** fn as the app calls it: while it runs, the work in the background waits. */
export function foreground<A extends unknown[], R>(fn: (...args: A) => R | Promise<R>): (...args: A) => Promise<R> {
  return async (...args: A) => {
    asking++;
    try {
      return await fn(...args);
    } finally {
      asking--;
      lastAsked = Date.now();
    }
  };
}

/** Resolves once the app has asked nothing for a second. */
export async function idle(): Promise<void> {
  while (asking > 0 || Date.now() - lastAsked < QUIET) await sleep(250);
}

// What was fetched, by key. An answer stays good while its version is the
// one asked for (a playlist's lastModifiedDate), or, without one, for maxAge.
// A key fetched in the background and then asked for by the app is the same
// fetch, which stops waiting for the app from then on: it's the app's.

interface Job {
  promise: Promise<unknown>;
  urgent: boolean;
  version?: string;
}

interface Entry {
  value?: unknown;
  at: number;
  version?: string;
  job?: Job;
}

export interface Freshness {
  /** What the answer has to have been fetched for; undefined for any. */
  version?: string;
  /** How long an answer stays good, in ms. */
  maxAge: number;
}

const entries = new Map<string, Entry>();
const KEPT_MOST = 200;

/**
 * The answer for key, kept or fetched with load. ahead marks a fetch for the
 * background, whose load calls pause between its requests to wait for the
 * app, and asks one thing at a time while urgent says false; the app's own,
 * and one the app comes to ask for, don't wait.
 */
export function kept<T>(
  key: string,
  fresh: Freshness,
  load: (pause: () => Promise<void>, urgent: () => boolean) => Promise<T>,
  ahead = false,
): Promise<T> {
  const e = entries.get(key);
  if (e && e.at && Date.now() - e.at < fresh.maxAge && (fresh.version === undefined || e.version === fresh.version)) {
    return Promise.resolve(e.value as T);
  }
  if (e?.job && e.job.version === fresh.version) {
    if (!ahead) e.job.urgent = true;
    return e.job.promise as Promise<T>;
  }
  const job: Job = { urgent: !ahead, version: fresh.version, promise: Promise.resolve() };
  const pause = () => (job.urgent ? Promise.resolve() : idle());
  const done = (store: boolean, value?: unknown) => {
    // Forgotten while it was fetched: what came is already old.
    if (entries.get(key)?.job !== job) return;
    if (store) entries.set(key, { value, at: Date.now(), version: fresh.version });
    else if (e?.at) entries.set(key, { ...e, job: undefined });
    else entries.delete(key);
  };
  job.promise = load(pause, () => job.urgent).then(
    (value) => {
      done(true, value);
      return value;
    },
    (err: unknown) => {
      done(false);
      throw err;
    },
  );
  entries.delete(key);
  entries.set(key, { ...(e ?? { at: 0 }), job });
  if (entries.size > KEPT_MOST) entries.delete(entries.keys().next().value!);
  return job.promise as Promise<T>;
}

/** Forgets every answer whose key starts with prefix, as it changed. */
export function forget(prefix: string): void {
  for (const key of [...entries.keys()]) if (key.startsWith(prefix)) entries.delete(key);
}

/** Forgets everything: another listener signed in, or none. */
export const forgetAll = (): void => entries.clear();
