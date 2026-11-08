// Plays, reported to Apple as its own players report them, so what's played
// here shows in Recently Played and counts toward Replay and recommendations.
// The web player's MusicKit posts every song's start and end to Apple's
// activity service. MyGo only says when a song starts, so a song's end goes
// with the next one's start, timed by the clock: a pause counts as playing,
// up to the song's length. The listener stops it with "off" in the plugin's
// Use Listening History setting.

import { catalog, first, request, storefront } from "./api.ts";
import { UA } from "./constants.ts";
import { developerToken, signedIn, userToken } from "./session.ts";
import { isCatalogID } from "./util.ts";

const ACTIVITY = "https://universal-activity-service.itunes.apple.com/play";

// MusicKit's codes: an event is a start or an end, and an end has a reason.
const PLAY_END = 0;
const PLAY_START = 1;
const NATURAL_END_OF_TRACK = 7;
const TRACK_SKIPPED_FORWARDS = 2;
const ITUNES_STORE_CONTENT = 1;
const MUSICKIT = 10;

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

function uuid(): string {
  const hex = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16));
  hex[12] = "4";
  hex[16] = ((parseInt(hex[16], 16) & 3) | 8).toString(16);
  const s = hex.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

// Who plays, the same while the plugin runs, as a MusicKit instance's guid is.
const guid = uuid();

interface Playing {
  id: string;
  duration: number;
  started: number;
}

let playing: Playing | null = null;

async function event(song: Playing, type: number, fields: Record<string, unknown>) {
  return {
    "build-version": "MusicKitApp/1.0 macOS/10.15.7 model/Macintosh build/1.0",
    "developer-token": await developerToken(),
    "user-token": userToken(),
    "user-agent": UA,
    "device-name": "Macintosh",
    guid,
    "event-type": type,
    type: ITUNES_STORE_CONTENT,
    "media-type": 0,
    "container-type": 0,
    "feature-name": "",
    ids: { "subscription-adam-id": song.id },
    "media-duration-in-milliseconds": song.duration,
    "persistent-id": uuid(),
    "private-enabled": false,
    "sb-enabled": true,
    "siri-initiated": false,
    "source-type": MUSICKIT,
    "store-front": await storefront(),
    offline: false,
    "utc-offset-in-seconds": -new Date().getTimezoneOffset() * 60,
    "start-position-in-milliseconds": 0,
    ...fields,
  };
}

/** The end of the song that played before, as far as the clock tells. */
async function ended(song: Playing, now: number) {
  const played = now - song.started;
  const whole = song.duration > 0 && played >= song.duration - 2000;
  return event(song, PLAY_END, {
    "end-position-in-milliseconds": song.duration > 0 ? Math.min(played, song.duration) : played,
    "end-reason-type": whole ? NATURAL_END_OF_TRACK : TRACK_SKIPPED_FORWARDS,
    timestamp: now,
  });
}

/** A song's length, from the catalog, for one MyGo plays without listing it first, as after a restart. */
async function lengthOf(id: string): Promise<number> {
  try {
    const ms = first(await catalog(`/songs/${id}`)).attributes?.durationInMillis ?? 0;
    noteDuration(id, ms);
    return ms;
  } catch {
    return 0;
  }
}

/** MyGo's word that a song started playing. */
export async function played({ id }: { id: string }): Promise<void> {
  const now = Date.now();
  // The song playing is swapped before anything is waited on, so plays that
  // come close together each end the one just before them.
  const before = playing;
  const on = signedIn() && reporting();
  const song = on && isCatalogID(id) ? { id, duration: durations.get(id) ?? 0, started: now } : null;
  playing = song;
  if (!on) return;
  const data = [];
  if (before) data.push(await ended(before, now));
  if (song) {
    if (!song.duration) song.duration = await lengthOf(id);
    data.push(await event(song, PLAY_START, { timestamp: now }));
  }
  if (!data.length) return;
  await request(ACTIVITY, { method: "POST", body: { client_id: "JSCLIENT", event_type: "JSPLAY", data } });
}
