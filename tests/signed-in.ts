// Signed in, against the real Apple Music: account, library, lyrics, and one
// song played whole (license, then amhelper, and ffmpeg as without it). The token comes from
// APPLE_MUSIC_TOKEN_FILE and is never printed.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { Lyrics, Playlist, Section, Station, Track } from "../src/types/music.ts";
import { load } from "./harness.ts";

const file = process.env.APPLE_MUSIC_TOKEN_FILE;
if (!file) throw new Error("Set APPLE_MUSIC_TOKEN_FILE to a file holding a media-user-token");
const token = readFileSync(file, "utf8").trim();
const { api } = await load({ storage: new Map([["mediaUserToken", token]]) });
const step = async (name: string, fn: () => Promise<string | undefined>) => {
  const t0 = Date.now();
  try {
    const r = await fn();
    console.log(`ok   ${name} (${Date.now() - t0} ms)${r ? `: ${r}` : ""}`);
  } catch (err) {
    const e = err as Error & { code?: string };
    console.log(`FAIL ${name}: ${e.code ? `[${e.code}] ` : ""}${e.message}`);
    process.exitCode = 1;
  }
};

const id = process.argv[2] || "1783644604";
await step("account", async () => JSON.stringify(await api.account()));
// The song through amhelper (npm run helper puts it in dist/plugin/bin), and
// through ffmpeg as on a platform without it: the same AAC, so the same
// audio once amhelper's edit list has left out the encoder's priming.
const withoutHelper = (await load({ storage: new Map([["mediaUserToken", token]]), withoutHelper: true })).api;
const dir = mkdtempSync(join(tmpdir(), "apple-"));
const decoded: Record<string, Buffer> = {};
const play = (name: string, plugin: typeof api, type: string) => async () => {
  const t0 = Date.now();
  const s = await plugin.stream({ id, quality: "high" });
  assert.equal(s.type, type);
  const res = await fetch(s.url);
  const reader = res.body!.getReader();
  const parts: Uint8Array[] = [];
  let first = 0;
  for (let r = await reader.read(); !r.done; r = await reader.read()) {
    first ||= Date.now() - t0;
    parts.push(r.value);
  }
  const all = Date.now() - t0;
  const body = Buffer.concat(parts);
  const path = join(dir, `${name}.${type}`);
  writeFileSync(path, body);
  const probe = execFileSync("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "stream=codec_name,profile,sample_rate,channels:format=duration",
    "-of",
    "compact",
    path,
  ])
    .toString()
    .trim()
    .replace(/\n/g, " | ");
  // Decoding the whole song catches audio that was left encrypted.
  const pcm = execFileSync("ffmpeg", ["-v", "error", "-i", path, "-f", "s16le", "-"], {
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1 << 30,
  });
  decoded[name] = pcm;
  return `${(body.length / 1e6).toFixed(1)} MB, first bytes ${first} ms, all ${all} ms, ${probe}`;
};
await step("stream (amhelper)", play("amhelper", api, "m4a"));
await step("stream (ffmpeg, without amhelper)", play("ffmpeg", withoutHelper, "aac"));
await step("the same audio both ways", async () => {
  const { amhelper, ffmpeg } = decoded;
  assert.ok(amhelper && ffmpeg, "a stream failed");
  const priming = 2112 * 4; // frames of 16-bit stereo
  assert.equal(ffmpeg.length - amhelper.length, priming, "amhelper's is other than the priming shorter");
  assert.ok(
    ffmpeg.subarray(0, priming).every((b) => b === 0),
    "the priming isn't silence",
  );
  assert.ok(ffmpeg.subarray(priming).equals(amhelper), "the audio differs");
  return `${amhelper.length / 4} frames, identical past the priming`;
});
await step("stream again (key kept)", async () => {
  const s = await api.stream({ id, quality: "high" });
  await (await fetch(s.url)).arrayBuffer();
  return s.url.replace(/\/[0-9a-f]{32}\//, "/<secret>/");
});
await step("lyrics", async () => {
  const l: Lyrics | null = await api.lyrics({ id });
  return l
    ? `${l.lines.length} lines, words: ${!!l.lines[0].words}, translation: ${l.lines.filter((x) => x.translation).length}, "${l.lines[0].text}"`
    : "none";
});
await step("recent", async () => (await api.recent()).length + " tracks");
await step("liked", async () => {
  const r = await api.liked({ offset: 0 });
  return `${r.tracks.length} tracks, more ${r.more}`;
});
await step("isLiked", async () => JSON.stringify(await api.isLiked({ ids: [id] })));
await step("savedAlbums", async () => (await api.savedAlbums({ offset: 0 })).albums.length + " albums");
await step("playlists", async () => {
  const p: Playlist[] = await api.playlists();
  return (
    p.length +
    " playlists: " +
    p
      .slice(0, 5)
      .map((x) => `${x.name}${x.mine ? "*" : ""}`)
      .join(", ")
  );
});
await step("first playlist", async () => {
  const p: Playlist[] = await api.playlists();
  if (!p.length) return "none";
  const l = await api.playlist({ id: p[0].id });
  return `${l.name}: ${l.tracks.length} tracks`;
});
await step("stations", async () => {
  const s: Station[] = await api.stations();
  return s.map((x) => `${x.id} ${x.name}`).join(", ");
});
await step("stationNext", async () => {
  const s: Station[] = await api.stations();
  if (!s.length) return "no station";
  return (await api.stationNext({ id: s[0].id }))
    .map((t: Track) => t.name)
    .slice(0, 5)
    .join(", ");
});
await step("home", async () => (await api.home()).sections.map((s: Section) => s.title).join(" / "));
await step("recentlyAdded", async () =>
  (await api.browse({ page: "recentlyAdded" })).sections
    .map((s: Section) => `${s.title} ${(s.albums ?? s.playlists ?? []).length}`)
    .join(", "),
);
