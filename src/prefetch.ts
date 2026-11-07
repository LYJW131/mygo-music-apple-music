// Getting ready before the listener picks a song, so it starts at once.

import { UA } from "./constants.ts";
import { ffmpeg } from "./ffmpeg.ts";
import { hasWrapper, prepare, preparedOrPreparing, warmLossless } from "./lossless.ts";
import { resolve, resolvedOrResolving, wantedQuality } from "./playback.ts";
import { signedIn } from "./session.ts";
import type { Track } from "./types/music.ts";
import { isCatalogID } from "./util.ts";

// Apple's play servers are a TLS handshake away, which from far off costs a
// good part of a second. While the listener browses, the connections are kept
// open, so that the song they pick next starts sooner.

const WARM_EVERY = 40 * 1000;
let warmed = 0;

// Lossless when the app last asked for it and there's a wrapper to ask.
const lossless = () => wantedQuality() === "lossless" && hasWrapper();

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
// isn't asking for keys faster than a listener would.

const FIRST = 3;
const PER_MINUTE = 15;
const QUEUED_MOST = 12;
let queue: string[] = [];
let running = false;
const startedAt: number[] = [];

const ready = (id: string) => (lossless() ? preparedOrPreparing(id) : resolvedOrResolving(id));

export function prefetch(tracks: Track[]): void {
  if (!lossless() && !signedIn()) return;
  const ids = tracks
    .filter((x) => !x.unavailable && isCatalogID(x.id))
    .slice(0, FIRST)
    .map((x) => x.id)
    .filter((id) => !ready(id));
  if (!ids.length) return;
  // The page opened last comes first; what's left of older ones waits behind.
  queue = [...ids, ...queue.filter((id) => !ids.includes(id))].slice(0, QUEUED_MOST);
  void pump();
}

async function pump(): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (let id = queue.shift(); id; id = queue.shift()) {
      const now = Date.now();
      while (startedAt.length && now - startedAt[0] > 60 * 1000) startedAt.shift();
      if (startedAt.length >= PER_MINUTE) {
        queue = [];
        break;
      }
      if (ready(id)) continue;
      startedAt.push(now);
      if (lossless()) await prepare(id, true).catch(() => {});
      else if (signedIn()) await resolve(id).catch(() => {});
    }
  } finally {
    running = false;
  }
}
