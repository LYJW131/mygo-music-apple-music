// amhelper, the program shipped with the plugin for this platform (helper/):
// it takes the encryption off Apple's audio as it comes, the AAC with the key
// the plugin got (playback.ts) and the ALAC with a wrapper's (lossless.ts),
// and serves it on this machine as a fragmented MP4 the app plays itself. It
// also keeps private playlists' covers (artwork.ts), and fetches the songs
// the listener uploaded (playback.ts). The plugin's zip for a
// platform without it has none, and plays through ffmpeg instead.

import { fail, t } from "./util.ts";

interface Helper {
  proc: HostProcess;
  /** http://127.0.0.1:<port>/<secret> */
  base: string;
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
let missing = false;

/** Whether this platform's zip came without amhelper, as far as is known. */
export const helperMissing = (): boolean => missing;

/** amhelper's address, starting it if it isn't running. */
export async function helperBase(): Promise<string> {
  return (await running()).base;
}

function running(): Promise<Helper> {
  // amhelper keeps key templates and the songs it worked out in cache, so
  // that a song played before plays at once after a restart.
  const config = JSON.stringify({
    ...settings(),
    cache: `${host.dataDir}/lossless`,
    covers: host.dataDir,
    uploads: `${host.dataDir}/uploads`,
  });
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
      throw fail("setup", t("Allow Apple Music to start programs in its settings, to play songs"));
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

/** Starts amhelper ahead of the first song. */
export function warmHelper(): void {
  if (!missing) running().catch(() => {});
}
