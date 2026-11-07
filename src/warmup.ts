// What's fetched of the listener's library before they open it: their
// favorites, albums, stations and what they added lately, and the playlists
// they changed last. A few seconds after the plugin starts, and again each
// time the app lists their playlists, which is when it comes back to the
// front. One thing at a time, each waiting for the app to be quiet
// (background.ts); what's still good isn't fetched again, so a playlist is
// fetched again only once it has changed.

import { idle } from "./background.ts";
import { recentlyAdded } from "./browse.ts";
import { libraryPlaylists, liked, recentlyChanged, savedAlbums } from "./library.ts";
import { libraryPlaylist } from "./pages.ts";
import { signedIn } from "./session.ts";
import { stations } from "./stations.ts";
import { sleep } from "./util.ts";

const FIRST_AFTER = 5 * 1000;
const PLAYLISTS = 20;
const EVERY = 60 * 1000;
const BETWEEN = 300;

let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let lastRun = 0;
// Bumped by signing in or out: a run for someone else stops.
let generation = 0;

/** Fetches the library ahead, soon, unless it was a minute ago. */
export function warmLibrary(after = FIRST_AFTER): void {
  if (!signedIn() || timer || running || Date.now() - lastRun < EVERY) return;
  timer = setTimeout(() => {
    timer = null;
    void run();
  }, after);
}

/** Stops what's fetched ahead: the listener signed in or out. */
export function stopWarming(): void {
  generation++;
  if (timer) clearTimeout(timer);
  timer = null;
  lastRun = 0;
}

async function run(): Promise<void> {
  running = true;
  lastRun = Date.now();
  const mine = generation;
  const steps: (() => Promise<unknown>)[] = [
    () => libraryPlaylists(true),
    () => liked({ offset: 0 }, true),
    () => savedAlbums({ offset: 0 }, true),
    () => stations(undefined, true),
    () => recentlyAdded(true),
  ];
  try {
    for (let i = 0; i < steps.length; i++) {
      await idle();
      if (mine !== generation || !signedIn()) return;
      await steps[i]().catch((e: unknown) => console.log(`Apple Music: fetching ahead: ${(e as Error).message}`));
      // The playlists, once the list says which changed last.
      if (i === 0) for (const id of recentlyChanged().slice(0, PLAYLISTS)) steps.push(() => libraryPlaylist(id, true));
      await sleep(BETWEEN);
    }
  } finally {
    running = false;
  }
}
