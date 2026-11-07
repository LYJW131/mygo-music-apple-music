// Packs dist/plugin into the zip a release carries, with its SHA-256:
// dist/release/mygo-music-apple-music-v<version>.zip. MyGo Music installs a
// release's .zip whose name names no platform, and finds plugin.json at its
// top.

import { zipSync, type Zippable } from "fflate";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { buildPlugin, out, root } from "./build.ts";

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

const zippable: Zippable = {};
// A fixed time, so that the same files make the same zip.
const mtime = new Date("2000-01-01T00:00:00Z");
for (const path of (await walk(out)).sort()) {
  zippable[relative(out, path).split("\\").join("/")] = [await readFile(path), { mtime }];
}
const zip = zipSync(zippable, { level: 9 });

const releaseDir = join(root, "dist/release");
await rm(releaseDir, { recursive: true, force: true });
await mkdir(releaseDir, { recursive: true });
const name = `mygo-music-apple-music-v${version}.zip`;
await writeFile(join(releaseDir, name), zip);
const sum = createHash("sha256").update(zip).digest("hex");
await writeFile(join(releaseDir, `${name}.sha256`), `${sum}  ${name}\n`);
console.log(`packed dist/release/${name} (${zip.length} bytes)`);
