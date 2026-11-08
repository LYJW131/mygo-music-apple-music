// Getting ready before the listener picks a song, so it starts at once.

import { UA } from "./constants.ts";
import { ffmpeg } from "./ffmpeg.ts";
import { find, hasWrapper, learnAudio, prepare, preparedOrPreparing, wakeWrapper, warmLossless } from "./lossless.ts";
import { resolve, resolvedOrResolving, wantedQuality } from "./playback.ts";
import { signedIn } from "./session.ts";
import type { Track } from "./types/music.ts";
import { isCatalogID, sleep } from "./util.ts";

// Apple's play servers are a TLS handshake away, which from far off costs a
// good part of a second. While the listener browses, the connections are kept
// open, so that the song they pick next starts sooner.

const WARM_EVERY = 40 * 1000;
let warmed = 0;

// Lossless when the app last asked for it and there's a wrapper to ask.
const lossless = () => wantedQuality() === "lossless" && hasWrapper();

// While the listener browses, the wrapper is woken ahead of the song they'll
// pick (lossless.ts). While songs play it's left alone: the songs coming up
// are worked out ahead, after which nothing asks it anything, and a wrapper
// on Cloudflare can go to sleep, which costs nothing, instead of being kept up
// for as long as the app is open. A song played within PLAYING counts as
// playing: few are longer.
const PLAYING = 10 * 60 * 1000;
let playedAt = -Infinity;

/** Wakes the wrapper while the listener is about, when songs play lossless and none is playing. */
export function wake(): void {
  if (lossless() && Date.now() - playedAt > PLAYING) wakeWrapper();
}

// So the songs coming up are worked out as one plays: the app doesn't say
// what it plays next, but it's most likely what follows the song on the page
// it was played from, an album or a playlist. When one of the next SOON isn't
// worked out, the next NEXT are, one after the other, which takes the wrapper
// half a minute or so; then it's left alone for most of an album, and goes
// to sleep. Asking for the next one each song would keep it up.
const SOON = 3;
const NEXT = 12;

// The songs of the pages opened, in their order, by the songs on them.
const lists = new Map<string, string[]>();
const LISTED_MOST = 5000;

/** The app asked for a song to play. */
export function playing(id: string): void {
  playedAt = Date.now();
  if (!lossless()) return;
  const list = lists.get(id);
  if (!list) return;
  const at = list.indexOf(id);
  const next = list.slice(at + 1, at + 1 + NEXT);
  if (next.slice(0, SOON).every(ready)) return;
  // The catalog says which have ALAC, for the songs past the page's first.
  void learnAudio(next)
    .catch(() => {})
    .then(() => enqueue(next));
}

export function warm(): void {
  if (lossless()) warmLossless();
  if (!signedIn() || Date.now() - warmed < WARM_EVERY) return;
  warmed = Date.now();
  ffmpeg().catch(() => {}); // the check costs a play its first tenth of a second
  for (const url of [
    "https://play.music.apple.com/",
    "https://play.itunes.apple.com/",
    "https://aod-ssl.itunes.apple.com/",
  ]) {
    fetch(url, { method: "HEAD", headers: { "User-Agent": UA } })
      .then((r) => r.body?.cancel())
      .catch(() => {});
  }
}

// Songs on the page the listener opened are worked out before they pick one:
// the first few of an album, a playlist, an artist's top songs or a search.
// It's what Apple, or the wrapper, would be asked anyway once they play, but
// not more than PER_MINUTE songs a minute, one at a time, so that the account
// isn't asking for keys faster than a listener would: more wait for the
// minute to pass.

const FIRST = 3;
const PER_MINUTE = 15;
const QUEUED_MOST = NEXT + FIRST;
let queue: string[] = [];
let running = false;
const startedAt: number[] = [];

const ready = (id: string) => (lossless() ? preparedOrPreparing(id) : resolvedOrResolving(id));

// For lossless, more of the page goes further, for nothing from the wrapper:
// what the catalog says of the first FOUND songs' audio, in one request, and
// their playlists from Apple's CDN, a few at a time. The one picked then
// waits for its keys only.

const FOUND = 20;
const FINDING_AT_ONCE = 4;

export function prefetch(tracks: Track[]): void {
  if (!lossless() && !signedIn()) return;
  const all = tracks.filter((x) => !x.unavailable && isCatalogID(x.id)).map((x) => x.id);
  for (const id of all) {
    lists.delete(id);
    lists.set(id, all);
  }
  while (lists.size > LISTED_MOST) lists.delete(lists.keys().next().value!);
  if (lossless()) {
    const page = all.slice(0, FOUND);
    void learnAudio(page)
      .catch(() => {})
      .then(() => {
        prepareFirst(all);
        return findAll(page);
      });
    return;
  }
  prepareFirst(all);
}

async function findAll(ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += FINDING_AT_ONCE) {
    await Promise.all(ids.slice(i, i + FINDING_AT_ONCE).map((id) => find(id).catch(() => {})));
  }
}

function prepareFirst(all: string[]): void {
  enqueue(all.slice(0, FIRST));
}

function enqueue(songs: string[]): void {
  const ids = songs.filter((id) => !ready(id));
  if (!ids.length) return;
  // The songs asked for last come first; what's left of older ones waits behind.
  queue = [...ids, ...queue.filter((id) => !ids.includes(id))].slice(0, QUEUED_MOST);
  void pump();
}

async function pump(): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (let id = queue.shift(); id; id = queue.shift()) {
      if (ready(id)) continue;
      for (;;) {
        const now = Date.now();
        while (startedAt.length && now - startedAt[0] >= 60 * 1000) startedAt.shift();
        if (startedAt.length < PER_MINUTE) break;
        await sleep(startedAt[0] + 60 * 1000 - now);
      }
      if (ready(id)) continue;
      startedAt.push(Date.now());
      if (lossless()) await prepare(id, true).catch(() => {});
      else if (signedIn()) await resolve(id).catch(() => {});
    }
  } finally {
    running = false;
  }
}
