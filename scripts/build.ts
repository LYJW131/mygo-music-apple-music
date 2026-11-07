// Builds the plugin as MyGo Music loads it into dist/plugin: plugin.json,
// locales, and index.js, the sources bundled into one module that imports
// nothing, since the app loads one file.

import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const root = join(import.meta.dirname, "..");
export const out = join(root, "dist/plugin");

/** What ships beside index.js. */
const files = ["plugin.json", "locales", "README.md", "README.en.md", "LICENSE"];

export async function buildPlugin(): Promise<void> {
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  const result = await build({
    absWorkingDir: root,
    entryPoints: ["src/index.ts"],
    outfile: join(out, "index.js"),
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    minify: false,
    sourcemap: false,
    metafile: true,
    legalComments: "inline",
    logLevel: "warning",
  });
  const outputs = Object.values(result.metafile.outputs);
  if (outputs.length !== 1 || outputs[0].imports.length !== 0) {
    throw new Error("The plugin has to be one JavaScript module that imports nothing");
  }
  for (const file of files) await cp(join(root, file), join(out, file), { recursive: true });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildPlugin();
  console.log(`built ${out}`);
}
