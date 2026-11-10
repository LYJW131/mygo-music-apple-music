// Plays, reported to Apple as the web player at music.apple.com reports them,
// so what's played here shows in Recently Played and counts toward Replay and
// recommendations. Its MusicKit posts each event to Apple's activity service
// as it happens, one to a request and in order, with the fields its web app
// gives one and no others, among them the album or playlist the song is
// played from: that is what Recently Played lists. MyGo doesn't say where a
// song is played from, so it's guessed: the album or playlist of the page last
// opened that has the song (prefetch.ts), or none. MyGo only says when a song
// starts, so a song's end
// goes just before the next one's start, timed by the clock: a pause counts as
// playing, up to the song's length. Pauses, seeking and the app quitting
// aren't said, and aren't reported. The listener stops it with "off" in the
// plugin's Use Listening History setting.

import { catalog, first, request, storefront } from "./api.ts";
import { UA } from "./constants.ts";
import { originOf, type Origin } from "./prefetch.ts";
import { developerToken, signedIn, userToken } from "./session.ts";
import { isCatalogID } from "./util.ts";

const ACTIVITY = "https://universal-activity-service.itunes.apple.com/play";

// MusicKit's codes: an event is a start or an end, and an end has a reason.
const PLAY_END = 0;
const PLAY_START = 1;
const TRACK_SKIPPED_FORWARDS = 2;
const CHANGED_ITEM = 5;
const NATURAL_END_OF_TRACK = 7;
const ITUNES_STORE_CONTENT = 1;
// What the web player says it is, among MusicKit's source types.
const WEB_APP = 16;
// What a start says of why it began: its container isn't the one played
// before, or nothing is known.
const HINT_NOT_SPECIFIED = 0;
const HINT_CONTAINER_CHANGED = 1;
// What MusicKit names where a song was started when it has no container.
const DEFAULT_FEATURE = "music_kit-integration";
// The web player's version, as its script said on 2026-11-10, and the
// system and machine its MusicKit reads from Safari on a Mac.
const BUILD = "AppleMusic/1.0 macOS/10.15.7 model/MacIntel build/2644.9.0-external";
// How the player is set to play, in MusicKit's numbers, 0 being unknown,
// which MusicKit sends when it isn't told: MyGo doesn't say whether it
// shuffles or repeats.
const PLAY_MODE = { "auto-play-mode": 0, "repeat-play-mode": 0, "shuffle-play-mode": 0 };

// Songs' lengths, from the pages they were listed on, as MyGo passes only an ID.
const durations = new Map<string, number>();

export function noteDuration(id: string, ms: number | undefined): void {
  if (!ms || !isCatalogID(id)) return;
  durations.delete(id);
  durations.set(id, ms);
  if (durations.size > 3000) durations.delete(durations.keys().next().value!);
}

/** Whether plays are reported: unless the setting says off. */
export const reporting = (): boolean => !/^(off|no|false|0)$/i.test(host.setting("listeningHistory").trim());

/** The 16 hex digits each event has of its own. */
function persistentID(): string {
  return Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
}

interface Playing {
  id: string;
  started: number;
  origin?: Origin;
}

/** An event to send, with what was true as it happened. */
interface PlayEvent {
  type: number;
  song: string;
  /** When it happened, as Date.now(). */
  at: number;
  origin?: Origin;
  /** For an end: how long the song played, by the clock. */
  played?: number;
  /** For an end: the next song is played from another container. */
  changed?: boolean;
  /** For a start. */
  hint?: number;
}

let playing: Playing | null = null;
const outbox: PlayEvent[] = [];
let sending: Promise<void> | null = null;

/** A song's length: as listed, or from the catalog, for one MyGo plays without listing it first, as after a restart. */
async function lengthOf(id: string): Promise<number> {
  const known = durations.get(id);
  if (known) return known;
  try {
    const ms = first(await catalog(`/songs/${id}`)).attributes?.durationInMillis ?? 0;
    noteDuration(id, ms);
    return ms;
  } catch {
    return 0;
  }
}

/** The event as Apple has it. */
async function body(e: PlayEvent): Promise<Record<string, unknown>> {
  const duration = await lengthOf(e.song);
  const out: Record<string, unknown> = {
    "build-version": BUILD,
    "developer-token": await developerToken(),
    "user-token": userToken(),
    "user-agent": UA,
    "event-type": e.type,
    type: ITUNES_STORE_CONTENT,
    "media-type": 0,
    "container-type": e.origin?.type ?? 0,
    "feature-name": e.origin?.feature ?? DEFAULT_FEATURE,
    ids: { "subscription-adam-id": e.song },
    "media-duration-in-milliseconds": duration,
    "persistent-id": persistentID(),
    "play-mode": PLAY_MODE,
    "private-enabled": false,
    "sb-enabled": true,
    "siri-initiated": false,
    "internal-build": false,
    "source-type": WEB_APP,
    "store-front": await storefront(),
    offline: false,
    "utc-offset-in-seconds": -new Date().getTimezoneOffset() * 60,
    "start-position-in-milliseconds": 0,
  };
  if (e.origin) out["container-ids"] = e.origin.ids;
  if (e.type === PLAY_START) {
    out["event-reason-hint-type"] = e.hint ?? HINT_NOT_SPECIFIED;
  } else {
    // MusicKit's positions are in whole seconds, but for a song played out.
    const played = e.played ?? 0;
    const whole = duration > 0 && played >= duration - 2000;
    out["end-position-in-milliseconds"] = whole ? duration : Math.floor(played / 1000) * 1000;
    out["end-reason-type"] = whole ? NATURAL_END_OF_TRACK : e.changed ? CHANGED_ITEM : TRACK_SKIPPED_FORWARDS;
  }
  // How long ago it happened, which it was a moment ago when MusicKit sends it.
  out["milliseconds-since-play"] = Math.max(Date.now() - e.at, 0);
  return out;
}

/** Sends what's queued, one event to a request, in order. Those that fail are dropped, as the web player's are. */
function drain(): Promise<void> {
  sending ??= (async () => {
    try {
      for (let e = outbox.shift(); e; e = outbox.shift()) {
        try {
          const data = [await body(e)];
          await request(ACTIVITY, { method: "POST", body: { client_id: "JSCLIENT", event_type: "JSPLAY", data } });
        } catch (err) {
          console.log(`Apple Music: reporting a play: ${(err as Error).message}`);
        }
      }
    } finally {
      sending = null;
    }
  })();
  return sending;
}

const sameOrigin = (a: Origin | undefined, b: Origin | undefined): boolean =>
  JSON.stringify(a?.ids ?? null) === JSON.stringify(b?.ids ?? null);

/** MyGo's word that a song started playing. Answers once what it said is sent. */
export async function played({ id }: { id: string }): Promise<void> {
  const now = Date.now();
  // The song playing is swapped before anything is waited on, so plays that
  // come close together each end the one just before them.
  const before = playing;
  const on = signedIn() && reporting();
  const song = on && isCatalogID(id) ? { id, started: now, origin: originOf(id) } : null;
  playing = song;
  if (!on) return;
  const changed = !!song?.origin && !sameOrigin(song.origin, before?.origin);
  if (before) {
    outbox.push({
      type: PLAY_END,
      song: before.id,
      at: now,
      origin: before.origin,
      played: now - before.started,
      changed,
    });
  }
  if (song) {
    const hint = changed ? HINT_CONTAINER_CHANGED : HINT_NOT_SPECIFIED;
    outbox.push({ type: PLAY_START, song: id, at: now, origin: song.origin, hint });
  }
  // A drain under way sends these too, after what came before them.
  while (sending) await sending;
  if (outbox.length) await drain();
}
