// Covers. Apple's catalog ones are templates the app sizes; a private
// playlist's is kept on this machine (see playlistArt).

import { UA } from "./constants.ts";
import { ffmpeg } from "./ffmpeg.ts";
import type { Artwork } from "./types/apple.ts";

/** A catalog cover, as the template the app fills in: {size} for both sides. */
export function art(artwork: Artwork | undefined): string | undefined {
  if (!artwork?.url) return undefined;
  return artwork.url
    .replace("{w}x{h}", "{size}x{size}")
    .replace("{w}", "{size}")
    .replace("{h}", "{size}")
    .replace("{c}", "cc") // a crop, as profile pictures take
    .replace("{f}", "jpg");
}

// A cover the listener chose for their own playlist is a presigned link to
// Apple's blobstore, at the size they uploaded it and no other. From some
// places it takes 20 to 35 seconds, past the 30 the app waits for a cover,
// so the bigger ones never show. ffmpeg fetches each once, with no deadline,
// and keeps it 600 pixels wide in the plugin's data; from then on the app
// reads it from there. Until then the cover is left out: given the link,
// the app would spend one of the few covers it loads at once on each for
// half a minute, and every other cover would wait behind them.

const COVERS_KEPT = 500;
// Each blobstore download is slow on its own, not for want of bandwidth.
const COVER_FETCHES = 4;
const queue: { name: string; url: string }[] = [];
let fetching = 0;

/** A library playlist's cover. */
export function playlistArt(artwork: Artwork | undefined): string | undefined {
  const url = artwork?.url;
  if (!url || !/^https:\/\/[^/]+\.blobstore\.apple\.com\//.test(url)) return art(artwork);
  const name = coverName(url);
  if (!name) return undefined;
  const kept = host.storage.get<Record<string, number>>("covers") ?? {};
  if (kept[name]) return fileURL(coverPath(name));
  if (!queue.some((c) => c.name === name)) queue.push({ name, url });
  for (let i = 0; i < COVER_FETCHES; i++) void keepCovers();
  return undefined;
}

/**
 * The blobstore object's own name, which stays as long as the picture does;
 * the signature around it changes every day.
 */
export function coverName(url: string): string {
  const m = url.match(/\/([0-9a-f]{8}-[0-9a-f-]{27})\/image\b/i);
  return m ? m[1].toLowerCase() : "";
}

const coverPath = (name: string): string => `${host.dataDir}/cover-${name}.jpg`;

export function fileURL(path: string): string {
  path = path.replace(/\\/g, "/");
  return "file://" + (path.startsWith("/") ? "" : "/") + encodeURI(path);
}

async function keepCovers(): Promise<void> {
  if (fetching >= COVER_FETCHES || !queue.length) return;
  fetching++;
  try {
    let bin: string;
    try {
      bin = await ffmpeg();
    } catch {
      queue.length = 0; // without ffmpeg, there's no keeping them
      return;
    }
    for (let next = queue.shift(); next; next = queue.shift()) {
      const { name, url } = next;
      // prettier-ignore
      const proc = host.spawn(bin, [
        "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
        "-user_agent", UA, "-rw_timeout", "60000000",
        "-i", url,
        "-vf", "scale='min(600,iw)':-2", "-frames:v", "1", "-update", "1", "-q:v", "3",
        coverPath(name),
      ]);
      proc.closeStdin();
      const timer = setTimeout(() => proc.kill(), 3 * 60 * 1000);
      const code = await proc.wait();
      clearTimeout(timer);
      if (code !== 0) continue;
      const kept = host.storage.get<Record<string, number>>("covers") ?? {};
      kept[name] = Date.now();
      const names = Object.keys(kept);
      if (names.length > COVERS_KEPT) {
        names.sort((a, b) => kept[a] - kept[b]);
        for (const old of names.slice(0, names.length - COVERS_KEPT)) delete kept[old];
      }
      host.storage.set("covers", kept);
    }
  } finally {
    fetching--;
  }
}
