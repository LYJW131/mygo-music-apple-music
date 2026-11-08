// Loads the built plugin (dist/plugin/index.js) the way MyGo Music does, as a
// module that imports nothing, with a stand-in for its host global. Needs
// node --experimental-vm-modules.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, SourceTextModule } from "node:vm";

export const dist = join(import.meta.dirname, "../dist/plugin");

export interface Options {
  storage?: Map<string, unknown>;
  settings?: Record<string, string>;
  language?: "en" | "zh-CN";
  /** Leaves amhelper out, as the plugin's zip for a platform without it does. */
  withoutHelper?: boolean;
}

// The plugin's exports, as the app calls them.
export type Plugin = Record<string, (...args: any[]) => any>;

function spawnProcess(command: string, args: string[]): HostProcess {
  // As MyGo does: a path of the plugin's own is in its folder, and one that
  // isn't there fails at once.
  if (!command.startsWith("/") && /[/\\]/.test(command)) {
    command = join(dist, command);
    if (!existsSync(command)) throw new Error(`exec: ${command}: no such file or directory`);
  }
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], cwd: dist });
  let err = "";
  let out = "";
  const lines: string[] = [];
  const waiting: ((line: string | null) => void)[] = [];
  let ended = false;
  let failed: Error | null = null;
  child.on("error", (e) => (failed = e));
  child.stderr.on("data", (d) => (err += d));
  child.stdout.on("data", (d) => {
    out += d;
    for (let i = out.indexOf("\n"); i >= 0; i = out.indexOf("\n")) {
      const line = out.slice(0, i);
      out = out.slice(i + 1);
      const reader = waiting.shift();
      if (reader) reader(line);
      else lines.push(line);
    }
  });
  const exited = new Promise<number>((resolve) =>
    child.on("close", (code) => {
      ended = true;
      if (out) {
        const reader = waiting.shift();
        if (reader) reader(out);
        else lines.push(out);
      }
      for (let reader = waiting.shift(); reader; reader = waiting.shift()) reader(null);
      resolve(code ?? -1);
    }),
  );
  return {
    pid: child.pid ?? 0,
    write: (s) => void child.stdin.write(s),
    closeStdin: () => void child.stdin.end(),
    readLine: () =>
      lines.length
        ? Promise.resolve(lines.shift() ?? null)
        : ended
          ? Promise.resolve(null)
          : new Promise((resolve) => waiting.push(resolve)),
    wait: async () => {
      if (failed) throw failed;
      return exited;
    },
    kill: () => void child.kill(),
    errorOutput: () => err,
  };
}

export async function load({
  storage = new Map(),
  settings = {},
  language = "zh-CN",
  withoutHelper = false,
}: Options = {}) {
  const locale = JSON.parse(await readFile(join(dist, "locales/zh-CN.json"), "utf8")) as Record<string, string>;
  const host: Host = {
    platform: process.platform === "win32" ? "windows" : process.platform,
    arch: process.arch,
    dir: dist,
    dataDir: await mkdtemp(join(tmpdir(), "mygo apple-")),
    storage: {
      get: <T>(k: string) => (storage.has(k) ? (structuredClone(storage.get(k)) as T) : undefined),
      set: (k, v) => void storage.set(k, structuredClone(v)),
      remove: (k) => void storage.delete(k),
    },
    setting: (key) => settings[key] ?? "",
    t: (text) => (language === "zh-CN" ? (locale[text] ?? text) : text),
    language: () => language,
    removeDataDir: () => {},
    openURL: (url) => console.log("openURL", url),
    spawn: (command, args) => {
      if (withoutHelper && command.includes("amhelper")) throw new Error(`exec: ${command}: no such file or directory`);
      return spawnProcess(command, args);
    },
  };
  const source = await readFile(join(dist, "index.js"), "utf8");
  const mod = new SourceTextModule(source, {
    identifier: "index.js",
    context: createContext({
      URL,
      URLSearchParams,
      TextEncoder,
      TextDecoder,
      fetch,
      setTimeout,
      clearTimeout,
      console,
      host,
      atob,
      btoa,
    }),
  });
  await mod.link(() => {
    throw new Error("a plugin imports nothing");
  });
  await mod.evaluate();
  return { api: mod.namespace as Plugin, storage, host };
}
