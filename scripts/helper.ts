// Builds amhelper, the Go program that plays lossless, for each platform a
// release ships it for: dist/helper/<os>-<arch>/amhelper[.exe]. With --here,
// only for this machine, into dist/plugin/bin/, to try it in the app.

import { execFileSync } from "node:child_process";
import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { out, root } from "./build.ts";

/** The platforms the releases carry amhelper for, as Go and MyGo Music name them. */
export const targets = [
  ["darwin", "arm64"],
  ["darwin", "amd64"],
  ["linux", "amd64"],
  ["linux", "arm64"],
  ["windows", "amd64"],
] as const;

export const helperDir = join(root, "dist/helper");

export const programName = (os: string) => (os === "windows" ? "amhelper.exe" : "amhelper");

function go(args: string[], env: Record<string, string> = {}): void {
  execFileSync("go", args, {
    cwd: join(root, "helper"),
    stdio: "inherit",
    env: { ...process.env, CGO_ENABLED: "0", ...env },
  });
}

/** Builds amhelper for os/arch and returns its path. */
export async function buildHelper(os: string, arch: string): Promise<string> {
  const dir = join(helperDir, `${os}-${arch}`);
  await mkdir(dir, { recursive: true });
  const path = join(dir, programName(os));
  // -trimpath and no build ID, so that the same source makes the same program.
  go(["build", "-trimpath", "-ldflags=-s -w -buildid=", "-o", path, "."], { GOOS: os, GOARCH: arch });
  return path;
}

const goNames: Record<string, string> = { x64: "amd64", arm64: "arm64", win32: "windows" };

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--here")) {
    const os = goNames[process.platform] ?? process.platform;
    const arch = goNames[process.arch] ?? process.arch;
    const path = await buildHelper(os, arch);
    await mkdir(join(out, "bin"), { recursive: true });
    await cp(path, join(out, "bin", programName(os)));
    console.log(`built ${join(out, "bin", programName(os))}`);
  } else {
    await rm(helperDir, { recursive: true, force: true });
    for (const [os, arch] of targets) await buildHelper(os, arch);
    console.log(`built amhelper for ${targets.length} platforms in ${helperDir}`);
  }
}
