// Packs dist/plugin into the zips a release carries, each with its SHA-256,
// in dist/release: mygo-music-apple-music-v<version>-<os>-<arch>.zip with
// amhelper for that platform in bin/, and mygo-music-apple-music-v<version>.zip
// without, for the others, which play AAC only. MyGo Music installs the zip
// named for its platform, else the one named for none, and finds plugin.json
// at its top.

import { zipSync, type Zippable } from "fflate";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { buildPlugin, out, root } from "./build.ts";
import { buildHelper, programName, targets } from "./helper.ts";

async function walk(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(path)));
    else found.push(path);
  }
  return found;
}

await buildPlugin();
const { version } = JSON.parse(await readFile(join(root, "plugin.json"), "utf8")) as { version: string };
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`plugin.json's version isn't x.y.z: ${version}`);

// A fixed time, so that the same files make the same zip.
const mtime = new Date("2000-01-01T00:00:00Z");
const plugin: Zippable = {};
for (const path of (await walk(out)).sort()) {
  if (relative(out, path).startsWith("bin")) continue; // a build to try here
  plugin[relative(out, path).split("\\").join("/")] = [await readFile(path), { mtime }];
}

const releaseDir = join(root, "dist/release");
await rm(releaseDir, { recursive: true, force: true });
await mkdir(releaseDir, { recursive: true });

async function pack(name: string, files: Zippable): Promise<void> {
  const zip = zipSync(files, { level: 9 });
  await writeFile(join(releaseDir, name), zip);
  const sum = createHash("sha256").update(zip).digest("hex");
  await writeFile(join(releaseDir, `${name}.sha256`), `${sum}  ${name}\n`);
  console.log(`packed dist/release/${name} (${zip.length} bytes)`);
}

await pack(`mygo-music-apple-music-v${version}.zip`, plugin);
for (const [os, arch] of targets) {
  const program = await readFile(await buildHelper(os, arch));
  // Unix's rwxr-xr-x in the entry's external attributes, which the app keeps.
  const attrs = (0o100755 << 16) >>> 0;
  await pack(`mygo-music-apple-music-v${version}-${os}-${arch}.zip`, {
    ...plugin,
    [`bin/${programName(os)}`]: [program, { mtime, os: 3, attrs }],
  });
}
