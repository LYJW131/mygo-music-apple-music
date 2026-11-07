// Playing a song whole: the web player's playlist for it, its key from
// Apple's license server, and ffmpeg taking the encryption off as the audio
// comes in.

import { request } from "./api.ts";
import { LICENSE, PLAYBACK, UA, WIDEVINE_SYSTEM } from "./constants.ts";
import { ffmpeg } from "./ffmpeg.ts";
import { needAccount } from "./session.ts";
import type { LicenseBody, WebPlaybackBody } from "./types/apple.ts";
import type { Stream } from "./types/music.ts";
import { codeOf, fail, isCatalogID, sleep, t } from "./util.ts";
import { b64decode, b64encode, equal, hex } from "./widevine/bytes.ts";
import { widevineChallenge } from "./widevine/cdm.ts";

const signInAgain = () => fail("signIn", t("Apple Music didn't accept the sign-in. Sign in again."));

/** The web player's playlist of the song: its encrypted .mp4 and its Widevine key. */
async function webPlayback(id: string): Promise<string> {
  needAccount();
  const body = await request<WebPlaybackBody>(PLAYBACK, {
    method: "POST",
    body: { salableAdamId: id, language: "en-US" },
    userHeader: "X-Apple-Music-User-Token",
  });
  if (body?.failureType) {
    const code = String(body.failureType);
    if (code === "2002") throw signInAgain();
    if (code === "3076" || code === "3077") {
      throw fail("unavailable", t("This song isn't available in your country or region"));
    }
    const why = `${code}${body.customerMessage ? `: ${body.customerMessage}` : ""}`;
    throw fail("unavailable", `${t("Apple Music won't play this song")} (${why})`);
  }
  const song = body?.songList?.[0];
  if (!song) throw fail("unavailable", t("Apple Music won't play this song"));
  const playlist = song["hls-playlist-url"] || song.assets?.find((a) => a.flavor === "28:ctrp256")?.URL;
  if (!playlist) throw fail("unavailable", t("Apple Music has no AAC of this song"));
  return playlist;
}

function m3u8Attributes(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of line.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) out[m[1]] = m[2].replace(/^"|"$/g, "");
  return out;
}

interface Media {
  /** The encrypted fragmented MP4. */
  media: string;
  /** The key's URI, which the license request names. */
  keyURI: string;
  kid: Uint8Array;
}

async function mediaOf(playlistURL: string): Promise<Media> {
  const text = await (await fetch(playlistURL, { headers: { "User-Agent": UA } })).text();
  let keyURI = "";
  let mapURI = "";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("#EXT-X-KEY:")) {
      const a = m3u8Attributes(line.slice(11));
      const widevine = (a.KEYFORMAT ?? "").toLowerCase().includes(WIDEVINE_SYSTEM);
      if (a.URI && (widevine || !keyURI)) keyURI = a.URI;
    } else if (line.startsWith("#EXT-X-MAP:")) {
      const a = m3u8Attributes(line.slice(11));
      if (a.URI) mapURI = new URL(a.URI, playlistURL).toString();
    }
  }
  if (!mapURI || !keyURI) throw fail("unavailable", t("Apple Music has no AAC of this song"));
  return { media: mapURI, keyURI, kid: b64decode(keyURI.slice(keyURI.indexOf(",") + 1)) };
}

/** The song's content key, in hex, from Apple's license server. */
async function contentKey(id: string, keyURI: string, kid: Uint8Array): Promise<string> {
  const session = widevineChallenge(kid);
  const body = await request<LicenseBody>(LICENSE, {
    method: "POST",
    body: {
      challenge: b64encode(session.challenge),
      uri: keyURI,
      "key-system": "com.widevine.alpha",
      adamId: id,
      isLibrary: false,
      "user-initiated": true,
    },
    userHeader: "X-Apple-Music-User-Token",
  });
  if (body?.failureType) {
    const code = String(body.failureType);
    if (code === "2002") throw signInAgain();
    throw fail("unavailable", `${t("Apple Music won't play this song")} (${code})`);
  }
  if (!body?.license) throw new Error(`${t("Apple Music sent no license")} (status ${body?.status})`);
  const content = session.parse(b64decode(body.license)).filter((k) => k.type === 2);
  const match = content.find((k) => kid.length >= 16 && equal(k.kid, kid.slice(-16))) ?? content[0];
  if (!match) throw new Error(t("Apple Music sent no key for this song"));
  return hex(match.key);
}

// What it takes to play a song, once worked out: where its encrypted audio is
// and its key. Neither changes, so they're kept, and a song played before
// starts without asking Apple anything. A few thousand of them are a few
// hundred kilobytes.

const KEYS_KEPT = 3000;

interface Kept {
  /** media */
  m: string;
  /** key */
  k: string;
}

interface Resolved {
  media: string;
  key: string;
  /** Whether it was kept from before rather than asked for now. */
  kept: boolean;
}

let keptSongs: Record<string, Kept> | null = null;

function kept(): Record<string, Kept> {
  keptSongs ??= host.storage.get<Record<string, Kept>>("resolved") ?? {};
  return keptSongs;
}

function remember(id: string, media: string, key: string): void {
  const all = kept();
  delete all[id];
  all[id] = { m: media, k: key };
  const ids = Object.keys(all);
  for (let i = 0; i < ids.length - KEYS_KEPT; i++) delete all[ids[i]];
  host.storage.set("resolved", all);
}

function forget(id: string): void {
  const all = kept();
  if (all[id]) {
    delete all[id];
    host.storage.set("resolved", all);
  }
}

const resolving = new Map<string, Promise<Resolved>>();

/** Whether the song is worked out already, or being worked out. */
export const resolvedOrResolving = (id: string): boolean => !!kept()[id] || resolving.has(id);

/**
 * The song's audio and key: kept, or from webPlayback, its playlist and a
 * license. Asked for twice at once, as the app asks ahead, it's worked out
 * once.
 */
export function resolve(id: string): Promise<Resolved> {
  const song = kept()[id];
  if (song) return Promise.resolve({ media: song.m, key: song.k, kept: true });
  let job = resolving.get(id);
  if (!job) {
    job = (async () => {
      const { media, keyURI, kid } = await mediaOf(await webPlayback(id));
      const key = await contentKey(id, keyURI, kid);
      remember(id, media, key);
      return { media, key, kept: false };
    })();
    resolving.set(id, job);
    job.finally(() => resolving.delete(id)).catch(() => {});
  }
  return job;
}

// ffmpeg takes the encryption off as the audio comes in from Apple, and
// answers the one request the app makes for it on this machine, as ADTS the
// app plays as it arrives. The audio is copied as it is. Not as a fragmented
// MP4: one written as it goes has no length in it, and MyGo Music 0.1.22
// reads all of such a file before playing it; ADTS it plays at once, its
// length the track's.
// The app keeps what it fetched in its own cache. No more than a few wait at
// a time, for songs skipped before the app asked for them.

const SERVING_MOST = 3;
const serving: HostProcess[] = [];

async function serve(media: string, key: string): Promise<string> {
  const bin = await ffmpeg();
  while (serving.length >= SERVING_MOST) serving.shift()?.kill();
  const port = 20000 + Math.floor(Math.random() * 40000);
  // prettier-ignore
  const proc = host.spawn(bin, [
    "-nostdin", "-hide_banner", "-nostats", "-loglevel", "info",
    "-user_agent", UA,
    "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5",
    "-rw_timeout", "15000000",
    // Read straight through: seekable, ffmpeg first walks the fragments
    // with a request for each, 27 for a song, which took seconds to start.
    "-seekable", "0",
    "-decryption_key", key,
    "-i", media,
    "-map", "0:a:0", "-c", "copy",
    "-f", "adts",
    "-listen", "1", `http://127.0.0.1:${port}/`,
  ]);
  proc.closeStdin();
  serving.push(proc);
  let stopped = false;
  const timer = setTimeout(() => proc.kill(), 20 * 60 * 1000);
  void proc.wait().then(() => {
    stopped = true;
    clearTimeout(timer);
    const at = serving.indexOf(proc);
    if (at >= 0) serving.splice(at, 1);
  });
  // ffmpeg prints the input it opened just before it listens; knocking on
  // the port to find out would use up the one request it answers.
  const until = Date.now() + 15000;
  while (!proc.errorOutput().includes("Input #0")) {
    if (stopped) throw new Error(`ffmpeg: ${proc.errorOutput().trim().split("\n").pop()}`);
    if (Date.now() > until) {
      proc.kill();
      throw new Error(t("The audio didn't start in time"));
    }
    await sleep(5);
  }
  // Between that line and listening ffmpeg only reads its options.
  await sleep(40);
  return `http://127.0.0.1:${port}/`;
}

export async function stream({ id }: { id: string }): Promise<Stream> {
  if (!isCatalogID(id)) throw fail("unavailable", t("Only songs in the Apple Music catalog play"));
  needAccount();
  let song = await resolve(id);
  let url: string;
  try {
    url = await serve(song.media, song.key);
  } catch (e) {
    if (!song.kept || codeOf(e)) throw e;
    // What was kept no longer opens, as Apple may have moved the audio: ask again.
    forget(id);
    song = await resolve(id);
    url = await serve(song.media, song.key);
  }
  return { url, type: "aac", quality: "high", bitRate: 256000 };
}
