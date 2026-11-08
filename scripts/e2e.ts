// Plays the built plugin end to end on this machine, without an Apple
// account: MyGo Music's own plugin host and player, amhelper built here, and
// cmd/fakeapple for Apple's CDN and a wrapper (e2e/mygo_test.go says what's
// checked). It runs against the oldest MyGo the plugin takes, minAppVersion,
// and the newest release, each checked out into dist/e2e. With versions as
// arguments (0.1.22, or latest), against those only.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { root } from "./build.ts";
import { programName } from "./helper.ts";

const MYGO = "https://github.com/egoist/mygo-music";
const work = join(root, "dist/e2e");
const exe = process.platform === "win32" ? ".exe" : "";

const run = (cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) =>
  execFileSync(cmd, args, { cwd: opts.cwd ?? root, stdio: "inherit", env: { ...process.env, ...opts.env } });

const semver = (v: string) => v.split(".").map(Number);
const newer = (a: string, b: string) => {
  const [x, y] = [semver(a), semver(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

function latest(): string {
  const refs = execFileSync("git", ["ls-remote", "--tags", "--refs", MYGO], { encoding: "utf8" });
  let best = "";
  for (const m of refs.matchAll(/refs\/tags\/v(\d+\.\d+\.\d+)$/gm)) if (!best || newer(m[1], best)) best = m[1];
  if (!best) throw new Error(`no releases at ${MYGO}`);
  return best;
}

const manifest = JSON.parse(readFileSync(join(root, "plugin.json"), "utf8")) as { minAppVersion: string };
const asked = process.argv.slice(2);
const versions = [
  ...new Set((asked.length ? asked : [manifest.minAppVersion, "latest"]).map((v) => (v === "latest" ? latest() : v))),
];

// The plugin, with amhelper for this machine in its bin, as a release's zip has it.
run("node", ["scripts/build.ts"]);
run("node", ["scripts/helper.ts", "--here"]);
if (
  !existsSync(join(root, "dist/plugin/bin", programName(process.platform === "win32" ? "windows" : process.platform)))
) {
  throw new Error("amhelper wasn't built into dist/plugin/bin");
}
mkdirSync(work, { recursive: true });
const fakeapple = join(work, `fakeapple${exe}`);
run("go", ["build", "-o", fakeapple, "./cmd/fakeapple"], { cwd: join(root, "helper"), env: { CGO_ENABLED: "0" } });

for (const version of versions) {
  const mygo = join(work, `mygo-${version}`);
  if (!existsSync(join(mygo, "go.mod"))) {
    run("git", [
      "-c",
      "advice.detachedHead=false",
      "clone",
      "--quiet",
      "--depth",
      "1",
      "--branch",
      `v${version}`,
      MYGO,
      mygo,
    ]);
  }
  copyFileSync(join(root, "e2e/mygo_test.go"), join(mygo, "internal/player/zz_applemusic_e2e_test.go"));
  console.log(`\nMyGo Music ${version} on ${process.platform}-${process.arch}`);
  run(
    "go",
    ["test", "-tags", "applemusic_e2e", "-run", "^TestAppleMusicEndToEnd$", "-count=1", "-v", "./internal/player"],
    {
      cwd: mygo,
      env: {
        CGO_ENABLED: "0",
        AM_E2E_PLUGIN: join(root, "dist/plugin"),
        AM_E2E_FAKEAPPLE: fakeapple,
        AM_E2E_TESTDATA: join(root, "helper/internal/fairplay/testdata"),
        AM_E2E_APP_VERSION: version,
      },
    },
  );
}
