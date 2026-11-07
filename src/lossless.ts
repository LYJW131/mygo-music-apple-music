// Lossless: Apple's ALAC, up to 24-bit/192 kHz, when the app's quality is
// Lossless and the listener has a wrapper. The wrapper, a wrapper-manager
// holding their Apple Music account, gives the playlist and the FairPlay key
// templates; amhelper, the program shipped with the plugin for this platform,
// fetches the audio from Apple, decrypts it and serves it on this machine as
// a fragmented MP4 the app plays as it comes. Without a wrapper, or for a
// song it can't play, the song plays as AAC.

import { catalog, first, query } from "./api.ts";
import type { Attributes } from "./types/apple.ts";
import type { Stream } from "./types/music.ts";
import { fail, t } from "./util.ts";

interface Helper {
  proc: HostProcess;
  /** http://127.0.0.1:<port>/<secret> */
  base: string;
}

interface Quality {
  sampleRate: number;
  bitDepth: number;
  bandwidth: number;
}

const settings = () => ({
  wrapper: host.setting("wrapper").trim(),
  token: host.setting("wrapperKey").trim(),
});

/** Whether the listener named a wrapper. */
export const hasWrapper = (): boolean => !!settings().wrapper;

const program = () => (host.platform === "windows" ? "bin/amhelper.exe" : "bin/amhelper");

// One amhelper at a time, started when first needed and again when the
// settings change or it ends.
let helper: Promise<Helper> | null = null;
let helperConfig = "";
// The plugin's zip for a platform without amhelper has none: AAC only.
let missing = false;

function running(): Promise<Helper> {
  // amhelper keeps key templates and the songs it worked out in cache, so
  // that a song played before plays at once after a restart.
  const config = JSON.stringify({ ...settings(), cache: `${host.dataDir}/lossless` });
  if (helper && helperConfig !== config) {
    void helper.then((h) => h.proc.kill()).catch(() => {});
    helper = null;
  }
  if (!helper) {
    helperConfig = config;
    const started = start(config);
    helper = started;
    started.catch(() => {
      if (helper === started) helper = null;
    });
  }
  return helper;
}

async function start(config: string): Promise<Helper> {
  let proc: HostProcess;
  try {
    proc = host.spawn(program(), []);
  } catch (e) {
    if (/allow/i.test((e as Error).message)) {
      throw fail("setup", t("Allow Apple Music to start programs in its settings, for lossless"));
    }
    missing = true;
    throw e;
  }
  // The key goes over stdin, as arguments are there for any process to read.
  proc.write(config + "\n");
  const hello = await Promise.race([proc.readLine(), new Promise<null>((r) => setTimeout(() => r(null), 5000))]);
  if (!hello) {
    proc.kill();
    throw new Error(`amhelper: ${proc.errorOutput().trim().split("\n").pop() ?? "didn't start"}`);
  }
  const { port, secret } = JSON.parse(hello) as { port: number; secret: string };
  const self: Helper = { proc, base: `http://127.0.0.1:${port}/${secret}` };
  void proc.wait().then(() => {
    void helper?.then((h) => {
      if (h === self) helper = null;
    });
  });
  return self;
}

// Which songs are lossless, and where their master playlist is, as the
// catalog says: noted from every page of songs, which come with both, so that
// a song played doesn't wait to be looked up. Following amdl, a song that
// isn't lossless plays as AAC without asking the wrapper anything; a lossless
// one starts from the catalog's playlist, so the wrapper is asked for its keys
// only; and a Hi-Res one from the wrapper's own, as the catalog's sometimes
// leaves out the 88.2, 96 and 192 kHz ALAC.

interface Audio {
  lossless: boolean;
  hiRes: boolean;
  master?: string;
}

const audio = new Map<string, Audio>();
const AUDIO_MOST = 5000;

/** Notes what a catalog song says of its audio. */
export function noteAudio(id: string, a: Attributes): void {
  if (!a.audioTraits) return;
  audio.delete(id);
  audio.set(id, {
    lossless: a.audioTraits.includes("lossless"),
    hiRes: a.audioTraits.includes("hi-res-lossless"),
    master: a.extendedAssetUrls?.enhancedHls,
  });
  if (audio.size > AUDIO_MOST) audio.delete(audio.keys().next().value!);
}

async function audioOf(id: string): Promise<Audio | null> {
  if (!audio.has(id)) {
    const song = first(await catalog(`/songs/${id}`, { "fields[songs]": "audioTraits,extendedAssetUrls" }));
    if (song?.attributes) noteAudio(id, song.attributes);
  }
  return audio.get(id) ?? null;
}

/** How amhelper is to find the song's playlist. */
function playlistQuery(a: Audio | null): string {
  if (!a?.master) return "";
  return query({ master: a.master, device: a.hiRes ? 1 : undefined });
}

// What prepare found, so that a song is asked about once: its quality and
// how it was found, or null when it has no ALAC.
interface Known extends Quality {
  query: string;
}
const known = new Map<string, Known | null>();
// known is kept in host.storage ("lossless") for a week, as amhelper keeps
// what it worked out: a song played since the app started is ready at once.
const KNOWN_DAYS = 7;
interface Kept {
  q: Known | null;
  at: number;
}
let kept: Record<string, Kept> | null = null;
let saving: ReturnType<typeof setTimeout> | null = null;

function loadKnown(): void {
  if (kept) return;
  kept = {};
  const now = Date.now();
  const stored = host.storage.get<Record<string, Kept>>("lossless") ?? {};
  for (const [id, k] of Object.entries(stored)) {
    if (now - k.at < KNOWN_DAYS * 86400e3) {
      kept[id] = k;
      known.set(id, k.q);
    }
  }
}

function saveKnown(): void {
  if (saving) return;
  saving = setTimeout(() => {
    saving = null;
    host.storage.set("lossless", kept);
  }, 3000);
}
// A song being worked out, and whether ahead of its playing.
const preparing = new Map<string, { job: Promise<Known | null>; ahead: boolean }>();
const KNOWN_MOST = 2000;

/** Whether the song is ready to play lossless, has none, or is being asked about. */
export const preparedOrPreparing = (id: string): boolean => {
  loadKnown();
  return known.has(id) || preparing.has(id);
};

/**
 * Asks amhelper to work the song out: its ALAC and the keys, which take the
 * wrapper a second or two. null when the song has no ALAC. ahead, for a song
 * the listener hasn't played yet, waits behind the songs they play; played
 * while it's worked out ahead, it's asked for again, which amhelper takes as
 * the same, now theirs.
 */
export function prepare(id: string, ahead = false): Promise<Known | null> {
  loadKnown();
  if (known.has(id)) return Promise.resolve(known.get(id) ?? null);
  const current = preparing.get(id);
  if (current && (ahead || !current.ahead)) return current.job;
  const job = (async () => {
    const [{ base }, a] = await Promise.all([running(), audioOf(id).catch(() => null)]);
    if (a && !a.lossless) {
      remember(id, null);
      return null;
    }
    const q = playlistQuery(a);
    const res = await fetch(`${base}/prepare/${id}${q}${ahead ? (q ? "&" : "?") + "ahead=1" : ""}`);
    const body = (await res.json()) as Quality & { code?: string; message?: string };
    if (res.status === 404 && body.code === "noALAC") {
      remember(id, null);
      return null;
    }
    if (!res.ok) throw new Error(`amhelper: ${body.message ?? res.status}`);
    const found = { sampleRate: body.sampleRate, bitDepth: body.bitDepth, bandwidth: body.bandwidth, query: q };
    remember(id, found);
    return found;
  })();
  const entry = { job, ahead };
  preparing.set(id, entry);
  job
    .finally(() => {
      if (preparing.get(id) === entry) preparing.delete(id);
    })
    .catch(() => {});
  return job;
}

function remember(id: string, q: Known | null): void {
  loadKnown();
  known.delete(id);
  known.set(id, q);
  kept![id] = { q, at: Date.now() };
  if (known.size > KNOWN_MOST) {
    const oldest = known.keys().next().value!;
    known.delete(oldest);
    delete kept![oldest];
  }
  saveKnown();
}

/** Starts amhelper ahead of the first song, if it's going to be wanted. */
export function warmLossless(): void {
  if (hasWrapper() && !missing) running().catch(() => {});
}

// A wrapper on Cloudflare sleeps after five idle minutes, and the song that
// wakes it waits for its container to start. So while the listener is about,
// amhelper asks it something now and then (it knows when it last did), and
// the first song finds it up.
const WAKE_EVERY = 60 * 1000;
let wokeAt = 0;

/** Wakes the wrapper ahead of the songs, if it's going to be wanted. */
export function wakeWrapper(): void {
  if (!hasWrapper() || missing || Date.now() - wokeAt < WAKE_EVERY) return;
  wokeAt = Date.now();
  running()
    .then((h) => fetch(`${h.base}/wake`, { method: "POST" }))
    .catch(() => {});
}

/**
 * The song as ALAC, or null when it should play as AAC: no wrapper, no
 * amhelper for this platform, no ALAC of it, or the wrapper failing.
 */
export async function losslessStream(id: string): Promise<Stream | null> {
  if (!hasWrapper() || missing) return null;
  let q: Known | null;
  try {
    q = await prepare(id);
  } catch (e) {
    if ((e as { code?: string }).code === "setup") throw e;
    console.log(`Apple Music: playing ${id} as AAC: ${(e as Error).message}`);
    return null;
  }
  if (!q) return null;
  const { base } = await running();
  return { url: `${base}/song/${id}.m4a${q.query}`, type: "m4a", quality: "lossless", bitRate: q.bandwidth };
}
