// Playing a song whole: the web player's playlist for it, its key from
// Apple's license server, and amhelper taking the encryption off as the
// audio comes in, or ffmpeg where the plugin's zip has no amhelper.

import { helperBase, helperMissing } from "./amhelper.ts";
import { request } from "./api.ts";
import { LICENSE, PLAYBACK, UA, WIDEVINE_SYSTEM } from "./constants.ts";
import { ffmpeg } from "./ffmpeg.ts";
import { losslessStream } from "./lossless.ts";
import { needAccount } from "./session.ts";
import type { LicenseBody, WebPlaybackBody } from "./types/apple.ts";
import type { Stream } from "./types/music.ts";
import { codeOf, fail, isCatalogID, isLibrarySong, sleep, t } from "./util.ts";
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

// A song the listener uploaded is asked for by its library ID, as the web
// player asks for it. Apple answers a link to the file as uploaded, or as
// iTunes made it from theirs: AAC at 256 kbps in a plain .m4a, unencrypted.
// The link lasts a day, so it isn't kept. From one connection it comes at
// half the speed it plays at, so amhelper fetches it over several, and keeps
// it (helper/upload.go). Without amhelper it doesn't play: ffmpeg would
// fetch it over the one connection.

/** The link Apple answers for the upload id, good for a day. */
async function uploadLink(id: string): Promise<string> {
  needAccount();
  const body = await request<WebPlaybackBody>(PLAYBACK, {
    method: "POST",
    body: { universalLibraryId: id, isLibrary: true, language: "en-US" },
    userHeader: "X-Apple-Music-User-Token",
  });
  if (body?.failureType) {
    const code = String(body.failureType);
    if (code === "2002") throw signInAgain();
    const why = `${code}${body.customerMessage ? `: ${body.customerMessage}` : ""}`;
    throw fail("unavailable", `${t("Apple Music won't play this song")} (${why})`);
  }
  // Only the unencrypted .m4a: a song bought or matched comes as an .m4p,
  // whose key this doesn't ask for.
  for (const song of body?.songList ?? []) {
    for (const a of song.assets ?? []) {
      if (a.metadata?.fileExtension === "m4a" && a.URL && /^https:\/\/[^/]+\.blobstore\.apple\.com\//.test(a.URL)) {
        return a.URL;
      }
    }
  }
  throw fail("unavailable", t("Apple Music won't play this song"));
}

async function uploadStream(id: string): Promise<Stream> {
  const url = await uploadLink(id);
  let base: string;
  try {
    base = await helperBase();
  } catch (e) {
    if (codeOf(e)) throw e;
    throw fail("unavailable", t("Songs you uploaded play only through amhelper, which this platform's plugin lacks"));
  }
  const res = await fetch(`${base}/upload/${id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  const body = (await res.json().catch(() => ({}))) as { size?: number; message?: string };
  if (!res.ok) throw new Error(`amhelper: ${body.message ?? res.status}`);
  return { url: `${base}/upload/${id}.m4a`, type: "m4a", quality: "high", bitRate: 256000, size: body.size };
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
  /** How long it plays, the encoder's priming with it: the segments' lengths added up. */
  seconds: number;
}

async function mediaOf(playlistURL: string): Promise<Media> {
  const text = await (await fetch(playlistURL, { headers: { "User-Agent": UA } })).text();
  let keyURI = "";
  let mapURI = "";
  let seconds = 0;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("#EXTINF:")) {
      seconds += parseFloat(line.slice(8)) || 0;
    } else if (line.startsWith("#EXT-X-KEY:")) {
      const a = m3u8Attributes(line.slice(11));
      const widevine = (a.KEYFORMAT ?? "").toLowerCase().includes(WIDEVINE_SYSTEM);
      if (a.URI && (widevine || !keyURI)) keyURI = a.URI;
    } else if (line.startsWith("#EXT-X-MAP:")) {
      const a = m3u8Attributes(line.slice(11));
      if (a.URI) mapURI = new URL(a.URI, playlistURL).toString();
    }
  }
  if (!mapURI || !keyURI) throw fail("unavailable", t("Apple Music has no AAC of this song"));
  return {
    media: mapURI,
    keyURI,
    kid: b64decode(keyURI.slice(keyURI.indexOf(",") + 1)),
    seconds: Math.round(seconds * 1e5) / 1e5,
  };
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

// What it takes to play a song, once worked out: where its encrypted audio is,
// its key and its length. None changes, so they're kept, and a song played
// before starts without asking Apple anything. A few thousand of them are a
// few hundred kilobytes.

const KEYS_KEPT = 3000;

interface Kept {
  /** media */
  m: string;
  /** key */
  k: string;
  /** seconds, which songs kept by 0.2.6 and before lack */
  s?: number;
}

interface Resolved {
  media: string;
  key: string;
  seconds: number;
  /** Whether it was kept from before rather than asked for now. */
  kept: boolean;
}

let keptSongs: Record<string, Kept> | null = null;

function kept(): Record<string, Kept> {
  keptSongs ??= host.storage.get<Record<string, Kept>>("resolved") ?? {};
  return keptSongs;
}

function remember(id: string, media: string, key: string, seconds: number): void {
  const all = kept();
  delete all[id];
  all[id] = { m: media, k: key, s: seconds };
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
export const resolvedOrResolving = (id: string): boolean => !!kept()[id]?.s || resolving.has(id);

/**
 * The song's audio, key and length: kept, or from webPlayback, its playlist
 * and a license. A song kept without its length has its playlist read again,
 * and keeps its key if the audio is where it was. Asked for twice at once,
 * as the app asks ahead, it's worked out once.
 */
export function resolve(id: string): Promise<Resolved> {
  const song = kept()[id];
  if (song?.s) return Promise.resolve({ media: song.m, key: song.k, seconds: song.s, kept: true });
  let job = resolving.get(id);
  if (!job) {
    job = (async () => {
      const { media, keyURI, kid, seconds } = await mediaOf(await webPlayback(id));
      const key = song && song.m === media ? song.k : await contentKey(id, keyURI, kid);
      remember(id, media, key, seconds);
      return { media, key, seconds, kept: false };
    })();
    resolving.set(id, job);
    job.finally(() => resolving.delete(id)).catch(() => {});
  }
  return job;
}

// amhelper takes the encryption off as the audio comes in from Apple, and
// serves it on this machine as a fragmented MP4 that says its length and
// skips the encoder's priming, which the app plays itself as it arrives. The
// AAC is copied as it is. The song is handed over first, with its key, in a
// request of its own: the address the app is given names the song only.
// amhelper opens the file at Apple as it's handed over, and says so if Apple
// has it no longer.

async function viaHelper(base: string, id: string, song: Resolved): Promise<string> {
  const res = await fetch(`${base}/aac/${id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ media: song.media, key: song.key, seconds: song.seconds }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
    // Only Apple no longer having the file is worth asking for the song afresh.
    throw Object.assign(new Error(`amhelper: ${body.message ?? res.status}`), { stale: body.code === "media" });
  }
  await res.body?.cancel();
  return `${base}/aac/${id}.m4a`;
}

// Where the plugin's zip has no amhelper, ffmpeg takes the encryption off,
// and answers the one request the app makes for it on this machine, as ADTS
// the app plays as it arrives. The audio is copied as it is. A fragmented MP4
// from ffmpeg says nothing of its length, and MyGo 0.1.22 reads one through
// before it plays; ADTS it takes its length for from the song's duration.
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

// The quality the app asked for last, kept: what the songs played next, and
// those worked out ahead, will want.
let wanted: string | null = null;
export const wantedQuality = (): string => (wanted ??= host.storage.get<string>("quality") ?? "");

export async function stream({ id, quality }: { id: string; quality?: string }): Promise<Stream> {
  // At every quality: there is no lossless of an upload to ask for.
  if (isLibrarySong(id)) return uploadStream(id);
  if (!isCatalogID(id)) throw fail("unavailable", t("Apple Music won't play this song"));
  if ((quality ?? "") !== wantedQuality()) host.storage.set("quality", (wanted = quality ?? ""));
  if (quality === "lossless") {
    const lossless = await losslessStream(id);
    if (lossless) return lossless;
  }
  needAccount();
  let song = await resolve(id);
  try {
    return await play(id, song);
  } catch (e) {
    if (!song.kept || codeOf(e) || (e as { stale?: boolean }).stale === false) throw e;
    // What was kept no longer opens, as Apple may have moved the audio: ask again.
    forget(id);
    song = await resolve(id);
    return await play(id, song);
  }
}

async function play(id: string, song: Resolved): Promise<Stream> {
  let base: string | null = null;
  if (!helperMissing()) {
    try {
      base = await helperBase();
    } catch (e) {
      // Not allowed to start programs: neither would ffmpeg be.
      if (codeOf(e)) throw e;
      if (!helperMissing())
        console.log(`Apple Music: playing through ffmpeg, as amhelper didn't start: ${(e as Error).message}`);
    }
  }
  if (base) return { url: await viaHelper(base, id, song), type: "m4a", quality: "high", bitRate: 256000 };
  return { url: await serve(song.media, song.key), type: "aac", quality: "high", bitRate: 256000 };
}
