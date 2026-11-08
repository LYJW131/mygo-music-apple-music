// ffmpeg, which takes the encryption off the audio and fetches the covers
// Apple serves too slowly for the app where the plugin's zip has no amhelper
// to do it (amhelper.ts).

import { fail, t } from "./util.ts";

let path: string | null = null;

function installFFmpeg(): string {
  switch (host.platform) {
    case "darwin":
      return t(
        "Apple Music plays through ffmpeg, which isn't installed. Install it with Homebrew (brew install ffmpeg), then play again.",
      );
    case "windows":
      return t(
        "Apple Music plays through ffmpeg, which isn't installed. Install it (in a terminal: winget install Gyan.FFmpeg), then restart MyGo Music.",
      );
    default:
      return t(
        "Apple Music plays through ffmpeg, which isn't installed. Install it with your package manager (such as sudo pacman -S ffmpeg or sudo apt install ffmpeg), then play again.",
      );
  }
}

/**
 * Where ffmpeg is. GUI apps don't get the shell's PATH on macOS, so
 * Homebrew's places are tried too: the same ones the process permission
 * names.
 */
export async function ffmpeg(): Promise<string> {
  if (path) return path;
  let broken: string | null = null;
  for (const candidate of ["ffmpeg", "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"]) {
    let proc: HostProcess;
    try {
      proc = host.spawn(candidate, ["-version"]);
    } catch (e) {
      if (/allow/i.test((e as Error).message)) {
        throw fail("setup", t("Allow Apple Music to start programs in its settings, for ffmpeg"));
      }
      continue;
    }
    proc.closeStdin();
    while ((await proc.readLine()) !== null) {
      // read it through, so it can exit
    }
    if ((await proc.wait()) === 0) return (path = candidate);
    broken ??= proc.errorOutput().trim().split("\n").pop() ?? "";
  }
  if (broken !== null) throw new Error(`${t("ffmpeg is installed but won't start. Reinstall it.")} (${broken})`);
  throw fail("unavailable", installFFmpeg());
}
