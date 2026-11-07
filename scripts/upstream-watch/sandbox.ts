// Commands the model asks for run under bubblewrap, in their own PID
// namespace, so they can't read this process's environment from /proc, and
// with no variable that looks like a credential: the runner hands the job a
// way to ask GitHub for an OIDC token, which buys Anthropic API time. That is
// all the sandbox is for. The runner is thrown away after the run, so they
// may write anywhere the runner's user can.

import { spawn, spawnSync } from "node:child_process";

const SECRET =
  /TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|^ANTHROPIC_|^ACTIONS_|^GITHUB_(OUTPUT|ENV|PATH|STEP_SUMMARY|STATE)$|^RUNNER_TRACKING/i;

export function childEnv(env: NodeJS.ProcessEnv, tmp: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) if (!SECRET.test(key)) out[key] = value;
  return { ...out, TMPDIR: tmp, GOTMPDIR: tmp, NO_COLOR: "1", GIT_PAGER: "cat", PAGER: "cat" };
}

export const quote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

export const hasBwrap = () =>
  process.platform === "linux" &&
  spawnSync("bwrap", [
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--unshare-pid",
    "--die-with-parent",
    "true",
  ]).status === 0;

export function wrap(command: string, bwrap: boolean): string[] {
  if (!bwrap) return ["bash", "-c", command];
  return [
    "bwrap",
    "--bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--unshare-pid",
    "--die-with-parent",
    "bash",
    "-c",
    command,
  ];
}

// Keeps the head and the tail: a failing build or test says what went wrong at
// the end, and what it was doing at the start.
export function clip(text: string, most: number): string {
  if (text.length <= most) return text;
  const half = Math.floor(most / 2);
  return `${text.slice(0, half)}\n\n[… ${text.length - most} characters cut …]\n\n${text.slice(-half)}`;
}

export type Ran = { code: number | string; output: string };

export function run(
  command: string,
  options: { cwd: string; bwrap: boolean; tmp: string; timeoutMs: number },
): Promise<Ran> {
  const [file, ...args] = wrap(command, options.bwrap);
  return new Promise((resolve) => {
    const child = spawn(file!, args, {
      cwd: options.cwd,
      env: childEnv(process.env, options.tmp),
      stdio: ["ignore", "pipe", "pipe"],
      signal: AbortSignal.timeout(options.timeoutMs),
      killSignal: "SIGKILL",
    });
    let output = "";
    // A runaway command can print gigabytes; past this, only the tail matters.
    const keep = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > 4_000_000) output = output.slice(0, 1_000_000) + "\n[…]\n" + output.slice(-1_000_000);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("error", (error) => {
      output += `\n${error.name === "AbortError" ? `timed out after ${options.timeoutMs / 1000} s` : error.message}`;
    });
    child.on("close", (code, signal) => resolve({ code: code ?? `signal ${signal}`, output }));
  });
}
