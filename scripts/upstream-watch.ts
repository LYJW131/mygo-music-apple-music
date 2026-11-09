// Has Claude check a MyGo Music release against the plugin, and writes its
// report as JSON. The Upstream workflow runs it; it can be run by hand too:
//
//   node scripts/upstream-watch.ts --upstream ../mygo-music --base v0.1.21 --target v0.1.22 --out /tmp/watch
//
// With --fix, a report that says the plugin needs a change is followed by the
// change: the model makes it in the plugin's tree, `npm run check` has to
// pass, and fix.json and changes.json (the commit, for propose.ts) are written
// next to the report.
//
// In GitHub Actions it signs in to the Anthropic API with the job's OIDC
// token (workload identity federation, the ANTHROPIC_* variables the workflow
// sets); elsewhere the SDK finds credentials as usual (ANTHROPIC_API_KEY and
// ANTHROPIC_BASE_URL, or a profile from `ant auth login`).

import Anthropic from "@anthropic-ai/sdk";
import { oidcFederationProvider } from "@anthropic-ai/sdk/lib/credentials/oidc-federation";
import type {
  BetaContentBlockParam,
  BetaMessageParam,
  BetaTool,
  BetaToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { randomBytes } from "node:crypto";
import { appendFileSync, createWriteStream, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { checkFix, FIX_SCHEMA, isFix, type Fix } from "./upstream-watch/fix.ts";
import { first, fixRequest, system, type Places } from "./upstream-watch/prompt.ts";
import { isReport, REPORT_SCHEMA, type Report, type Usage } from "./upstream-watch/report.ts";
import { clip, hasBwrap, quote, run, type Ran } from "./upstream-watch/sandbox.ts";

const { values: args } = parseArgs({
  options: {
    plugin: { type: "string", default: process.cwd() },
    upstream: { type: "string" },
    base: { type: "string" },
    target: { type: "string" },
    notes: { type: "string" },
    out: { type: "string" },
    model: { type: "string", default: "claude-fable-5-2" },
    effort: { type: "string", default: "medium" },
    // fast: the model's fast mode, at twice the price.
    speed: { type: "string", default: "standard" },
    minutes: { type: "string", default: "30" },
    dollars: { type: "string", default: "10" },
    fakeapple: { type: "string", default: "fakeapple" },
    fix: { type: "boolean", default: false },
    "fix-minutes": { type: "string", default: "20" },
    "fix-dollars": { type: "string", default: "10" },
  },
});
if (!args.upstream || !args.base || !args.target || !args.out) {
  console.error(
    "usage: upstream-watch.ts --upstream DIR --base TAG --target TAG --out DIR [--notes FILE] [--plugin DIR] [--fakeapple PATH] [--fix]",
  );
  process.exit(2);
}
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const effort = args.effort as (typeof EFFORTS)[number];
if (!EFFORTS.includes(effort)) throw new Error(`--effort is one of ${EFFORTS.join(", ")}`);
const fast = args.speed === "fast";
if (!fast && args.speed !== "standard") throw new Error("--speed is standard or fast");
// Breakers, for the check and then the fix: past the soft limits the model is
// told to hand in what it has; past the hard ones, half as much again, that
// phase stops without it.
const minutes = Number(args.minutes);
const dollars = Number(args.dollars);
const fixMinutes = Number(args["fix-minutes"]);
const fixDollars = Number(args["fix-dollars"]);
const MOST_TURNS = 150;
if (![minutes, dollars, fixMinutes, fixDollars].every((n) => n > 0))
  throw new Error("--minutes, --dollars, --fix-minutes and --fix-dollars are positive numbers");

const plugin = resolve(args.plugin);
const upstream = resolve(args.upstream);
const out = resolve(args.out);
mkdirSync(out, { recursive: true });
const scratch = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), "watch-"));
const places: Places = {
  plugin,
  upstream,
  scratch,
  base: args.base,
  target: args.target,
  minutes,
  dollars,
  fakeapple: args.fakeapple!,
};

const started = Date.now();
const bwrap = hasBwrap();
if (!bwrap && process.env.CI)
  throw new Error("bubblewrap can't make a sandbox here; the commands would see the OIDC request token");
if (!bwrap) console.error("No bubblewrap: commands run unsandboxed.");

const client = new Anthropic({ ...auth(), maxRetries: 4, timeout: 10 * 60_000 });

function auth(): ConstructorParameters<typeof Anthropic>[0] {
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const token = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !token) return {};
  delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  const need = (name: string) =>
    process.env[name] ||
    (() => {
      throw new Error(`${name} isn't set`);
    })();
  return {
    credentials: oidcFederationProvider({
      // GitHub's token lasts minutes and the exchange is redone when Anthropic's
      // expires, so each exchange asks GitHub for a fresh one.
      identityTokenProvider: async () => {
        const res = await fetch(`${url}&audience=${encodeURIComponent("https://api.anthropic.com")}`, {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) throw new Error(`GitHub's OIDC token: ${res.status}`);
        return ((await res.json()) as { value: string }).value;
      },
      federationRuleId: need("ANTHROPIC_FEDERATION_RULE_ID"),
      organizationId: need("ANTHROPIC_ORGANIZATION_ID"),
      serviceAccountId: process.env.ANTHROPIC_SERVICE_ACCOUNT_ID,
      workspaceId: process.env.ANTHROPIC_WORKSPACE_ID,
      baseURL: "https://api.anthropic.com",
      fetch,
    }),
  };
}

function sh(command: string, timeoutMs = 120_000, sandboxed = true, cwd = plugin): Promise<Ran> {
  return run(command, { cwd, bwrap: sandboxed && bwrap, tmp: scratch, timeoutMs });
}

const git = async (command: string) => (await sh(`git -C ${quote(upstream)} ${command}`)).output;
const pluginGit = (command: string, timeoutMs?: number) => sh(`git -C ${quote(plugin)} ${command}`, timeoutMs);
const range = `${quote(args.base)} ${quote(args.target)}`;
const [commits, stat] = await Promise.all([
  git(`log --no-merges --format='%h %s (%an)' ${quote(args.base)}..${quote(args.target)}`),
  git(`diff --stat=120 ${range}`),
]);
const notes = args.notes ? readFileSync(args.notes, "utf8") : "";
// The plugin commit checked, which a fix is made on.
const pluginHead = (await pluginGit("rev-parse HEAD")).output.trim();
if (!/^[0-9a-f]{40}$/.test(pluginHead)) throw new Error(`${plugin} isn't a git checkout`);

const tools: BetaTool[] = [
  {
    name: "bash",
    description: `Runs a bash command and returns its output (stdout and stderr, clipped to 30000 characters) and exit code. The working directory is ${plugin}. Each call is a fresh shell: processes it starts end with it, so start a server and probe it in the same command. Default timeout 120 s, at most 1200.`,
    input_schema: {
      type: "object",
      properties: { command: { type: "string" }, timeout: { type: "integer", description: "Seconds." } },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description:
      "Reads a text file with line numbers. Give offset (1-based line) and limit (lines, default 400) for a long file.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" } },
      required: ["path"],
    },
  },
  {
    name: "upstream_diff",
    description: `MyGo's diff between two refs (default ${args.base}..${args.target}), limited to paths if given. stat: true lists files only. Clipped to 60000 characters: narrow paths when it is.`,
    input_schema: {
      type: "object",
      properties: {
        paths: { type: "array", items: { type: "string" } },
        stat: { type: "boolean" },
        from: { type: "string" },
        to: { type: "string" },
      },
    },
  },
  {
    name: "install_packages",
    description:
      "Installs Ubuntu packages with apt-get (as root, which bash can't be). Give package names; returns apt's output.",
    input_schema: {
      type: "object",
      properties: { packages: { type: "array", items: { type: "string" } } },
      required: ["packages"],
    },
  },
  {
    name: "submit_report",
    description: "Hands in the report. Call it once, when you are done checking.",
    input_schema: REPORT_SCHEMA as unknown as BetaTool["input_schema"],
    strict: true,
  },
  // Listed from the start, so the tools stay the same and the cache holds.
  {
    name: "submit_fix",
    description:
      "Only when asked, after the report: hands in the change you made in the plugin's tree. npm run check runs on it first; if that fails you get its output, so fix it and call again.",
    input_schema: FIX_SCHEMA as unknown as BetaTool["input_schema"],
    strict: true,
  },
];

let report: Report | null = null;
let fix: Fix | null = null;
let fixing = false;
let toolCalls = 0;
// The models that answered: the server can fall back to another.
const models = new Set<string>();
// When the phase under way stops, which bash's timeouts keep to.
let hardStop = started + minutes * 1.5 * 60_000;

async function call(name: string, input: Record<string, unknown>): Promise<string> {
  toolCalls++;
  switch (name) {
    case "bash": {
      if (typeof input.command !== "string") throw new Error("command must be a string");
      const left = Math.max((hardStop - Date.now()) / 1000, 10);
      const seconds = Math.min(Math.max(Number(input.timeout) || 120, 1), 1200, left);
      const r = await sh(input.command, seconds * 1000);
      return `exit ${r.code}\n${clip(r.output, 30_000)}`;
    }
    case "read_file": {
      if (typeof input.path !== "string") throw new Error("path must be a string");
      const from = Math.max(Number(input.offset) || 1, 1);
      const to = from + Math.min(Math.max(Number(input.limit) || 400, 1), 2000) - 1;
      const r = await sh(
        `awk -v a=${from} -v b=${to} 'NR>=a && NR<=b { printf "%6d\\t%s\\n", NR, $0 } NR>b { exit }' ${quote(input.path)}`,
      );
      if (r.code !== 0) throw new Error(r.output.trim() || `exit ${r.code}`);
      return clip(r.output, 60_000) || "(no lines there)";
    }
    case "upstream_diff": {
      const from = typeof input.from === "string" ? input.from : args.base!;
      const to = typeof input.to === "string" ? input.to : args.target!;
      const paths = Array.isArray(input.paths) ? input.paths.filter((p): p is string => typeof p === "string") : [];
      const r = await sh(
        `git -C ${quote(upstream)} diff ${input.stat ? "--stat=160" : ""} ${quote(from)} ${quote(to)} -- ${paths.map(quote).join(" ")}`,
      );
      if (r.code !== 0) throw new Error(r.output.trim());
      return clip(r.output, 60_000) || "(no changes)";
    }
    case "install_packages": {
      const names = Array.isArray(input.packages) ? input.packages : [];
      // Only names: apt-get takes options from anything starting with a dash.
      if (!names.length || !names.every((n) => typeof n === "string" && /^[a-z0-9][a-z0-9+.:=~-]*$/.test(n)))
        throw new Error("packages must be apt package names");
      const r = await sh(
        `set -o pipefail; sudo -n apt-get install -y -q --no-install-recommends ${names.map(quote).join(" ")} 2>&1 | tail -n 40`,
        600_000,
        false,
      );
      return `exit ${r.code}\n${clip(r.output, 10_000)}`;
    }
    case "submit_report":
      if (report) throw new Error("The report is in already.");
      if (!isReport(input)) throw new Error("The report doesn't match the schema.");
      report = input;
      return "Received.";
    case "submit_fix":
      if (!fixing) throw new Error("Not now: only when you're asked to make the fix, after the report.");
      if (!isFix(input)) throw new Error("The fix doesn't match the schema.");
      return takeFix(input);
    default:
      throw new Error(`No tool ${name}`);
  }
}

// A file is what GitHub's createCommitOnBranch takes: its path and contents.
type Changes = { additions: { path: string; contents: string }[]; deletions: { path: string }[] };

// Checks the change in the plugin's tree, and keeps it as one commit's files.
async function takeFix(input: Fix): Promise<string> {
  const wrong = checkFix(input);
  if (wrong) throw new Error(`The message: ${wrong}.`);
  const staged = await pluginGit("add -A");
  if (staged.code !== 0) throw new Error(staged.output.trim());
  const listed = await pluginGit(`diff --cached --no-renames --name-status -z ${pluginHead}`);
  const fields = listed.output.split("\0").filter(Boolean);
  const files: { status: string; path: string }[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) files.push({ status: fields[i]!, path: fields[i + 1]! });
  if (!files.length) throw new Error(`Nothing changed in ${plugin}: make the change there, then call again.`);
  // The bot's token can't change workflows, and nothing should without lyjw.
  const workflows = files.filter((f) => f.path.startsWith(".github/"));
  if (workflows.length)
    throw new Error(`Leave .github/ alone (${workflows.map((f) => f.path).join(", ")}); undo that and call again.`);
  const check = await sh("npm run check 2>&1", Math.max(Math.min(hardStop - Date.now(), 20 * 60_000), 60_000));
  if (check.code !== 0) throw new Error(`npm run check failed (exit ${check.code}):\n${clip(check.output, 12_000)}`);
  const changes: Changes = { additions: [], deletions: [] };
  for (const file of files) {
    if (file.status === "D") changes.deletions.push({ path: file.path });
    else
      changes.additions.push({ path: file.path, contents: readFileSync(join(plugin, file.path)).toString("base64") });
  }
  const patch = await pluginGit(`diff --cached --binary ${pluginHead}`);
  writeFileSync(join(out, "fix.patch"), patch.output);
  writeFileSync(join(out, "changes.json"), JSON.stringify(changes));
  fix = input;
  return `Received: npm run check passed, ${files.length} files changed.`;
}

const transcript = createWriteStream(join(out, "transcript.jsonl"), { flags: "w" });
const log = (entry: object) => transcript.write(`${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);

const messages: BetaMessageParam[] = [{ role: "user", content: first(places, notes, commits, stat) }];
const systemText = system(places);
log({ system: systemText, first: messages[0]!.content });

const totals = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
let turns = 0;
// Dollars per million tokens: input, 5-minute cache writes, cache reads,
// output. Each turn is priced by the model that answered it, as a fallback
// can be another; one not listed is priced as the dearest, so the breakers
// stay on the safe side. Fast mode doubles all of them.
const PRICES: Record<string, [number, number, number, number]> = {
  "claude-fable-5-2": [8, 10, 0.2, 40],
  "claude-fable-5-1": [10, 12.5, 0.25, 50],
  "claude-opus-5-5": [4, 5, 0.2, 20],
};
let dollarsSpent = 0;
const spent = () => dollarsSpent;

type Phase = {
  // What it ends with, in the model's words and in lyjw's.
  tool: string;
  thing: string;
  done: () => boolean;
  minutes: number;
  dollars: number;
};

// Talks until the phase's tool has been called. The conversation carries on
// from one phase to the next, so the fix is made knowing the check.
async function converse(phase: Phase): Promise<void> {
  const begun = Date.now();
  const before = spent();
  const turnsBefore = turns;
  hardStop = begun + phase.minutes * 1.5 * 60_000;
  let nudges = 0;
  let warned = false;
  while (!phase.done()) {
    if (Date.now() > hardStop) throw new Error(`没在 ${phase.minutes * 1.5} 分钟内交${phase.thing}，按时间熔断`);
    if (spent() - before > phase.dollars * 1.5)
      throw new Error(`花费超过 $${phase.dollars * 1.5} 还没交${phase.thing}，按花费熔断`);
    if (turns - turnsBefore >= MOST_TURNS) throw new Error(`${MOST_TURNS} 轮还没交${phase.thing}，按轮数熔断`);
    turns++;
    const message = await client.beta.messages
      .stream({
        model: args.model!,
        max_tokens: 32_000,
        system: systemText,
        tools,
        messages,
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort },
        ...(fast ? { speed: "fast" as const } : {}),
        // Each turn resends the whole conversation: caching the end of it
        // makes the next turn read all but its newest part from the cache.
        cache_control: { type: "ephemeral" },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      })
      .finalMessage();
    // The whole content goes back as it came, thinking included: the API checks
    // that earlier turns are unchanged.
    messages.push({ role: "assistant", content: message.content });
    log({
      turn: turns,
      model: message.model,
      stop: message.stop_reason,
      usage: message.usage,
      content: message.content,
    });
    models.add(message.model);
    totals.input += message.usage.input_tokens;
    totals.cacheWrite += message.usage.cache_creation_input_tokens ?? 0;
    totals.cacheRead += message.usage.cache_read_input_tokens ?? 0;
    totals.output += message.usage.output_tokens;
    const [input, write, read, output] = PRICES[message.model.replace(/^.*\//, "")] ?? PRICES["claude-fable-5-1"]!;
    dollarsSpent +=
      ((message.usage.speed === "fast" ? 2 : 1) *
        (message.usage.input_tokens * input +
          (message.usage.cache_creation_input_tokens ?? 0) * write +
          (message.usage.cache_read_input_tokens ?? 0) * read +
          message.usage.output_tokens * output)) /
      1_000_000;
    for (const block of message.content) {
      if (block.type === "thinking" && block.thinking) console.error(`[think] ${block.thinking.slice(0, 300)}`);
      if (block.type === "text") console.error(`[text] ${block.text.slice(0, 300)}`);
    }

    if (message.stop_reason === "refusal")
      throw new Error(`the model declined (${message.stop_details?.category ?? "no category"})`);
    const uses = message.content.filter((b) => b.type === "tool_use");
    const reply: BetaContentBlockParam[] = await Promise.all(
      uses.map((use) => {
        console.error(`[tool] ${use.name} ${JSON.stringify(use.input).slice(0, 200)}`);
        return result(use.id, () => call(use.name, use.input as Record<string, unknown>));
      }),
    );
    // A phase's last tool result goes back with the next phase's request, so
    // the conversation stays whole.
    if (phase.done()) {
      messages.push({ role: "user", content: reply });
      return;
    }
    if (message.stop_reason === "max_tokens" && !uses.length)
      reply.push({ type: "text", text: "Your answer was cut off. Carry on." });
    else if (!uses.length) {
      const said = message.content
        .flatMap((b) => (b.type === "text" ? [b.text.trim()] : []))
        .join(" ")
        .slice(0, 600);
      // It may decline to make a fix, as it was told it could.
      if (phase.tool === "submit_fix") throw new Error(`Claude 没做修改${said ? `：${said}` : ""}`);
      if (++nudges > 2) throw new Error(`the model stopped without the ${phase.tool}`);
      reply.push({ type: "text", text: `You haven't called ${phase.tool}. Finish what is needed, then call it.` });
    }
    const over =
      Date.now() - begun > phase.minutes * 60_000
        ? "time"
        : spent() - before > phase.dollars
          ? "budget"
          : turns - turnsBefore >= MOST_TURNS - 10
            ? "turns"
            : null;
    if (!warned && over) {
      warned = true;
      reply.push({
        type: "text",
        text:
          phase.tool === "submit_report"
            ? `The ${over} is used up. Call submit_report now with what you have; put what you didn't get to in unverified.`
            : `The ${over} for the fix is used up. If npm run check passes, call submit_fix now; if it can't, stop.`,
      });
    }
    messages.push({ role: "user", content: reply });
  }
}

async function result(id: string, work: () => Promise<string>): Promise<BetaToolResultBlockParam> {
  try {
    return { type: "tool_result", tool_use_id: id, content: await work() };
  } catch (error) {
    return { type: "tool_result", tool_use_id: id, content: (error as Error).message, is_error: true };
  }
}

let failure: string | null = null;
let fixFailure: string | null = null;
try {
  await converse({ tool: "submit_report", thing: "报告", done: () => !!report, minutes, dollars });
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  console.error(error);
}

const verdict = (report as Report | null)?.verdict;
if (args.fix && (verdict === "needed" || verdict === "breaking")) {
  try {
    // What the model did to the tree while checking isn't the fix.
    const reset = await pluginGit(`reset -q --hard ${pluginHead} && git -C ${quote(plugin)} clean -fdq`);
    if (reset.code !== 0) throw new Error(`还原插件目录失败：${reset.output.trim()}`);
    const last = messages.at(-1)!;
    (last.content as BetaContentBlockParam[]).push({ type: "text", text: fixRequest(places, fixMinutes, fixDollars) });
    fixing = true;
    await converse({
      tool: "submit_fix",
      thing: "修改",
      done: () => !!fix,
      minutes: fixMinutes,
      dollars: fixDollars,
    });
  } catch (error) {
    fixFailure = error instanceof Error ? error.message : String(error);
    console.error(error);
  }
}

const cost = spent();
const usage: Usage = {
  model: args.model!,
  effort: fast ? `${effort}, fast` : effort,
  minutes: Math.round((Date.now() - started) / 6000) / 10,
  turns,
  toolCalls,
  costUsd: Math.round(cost * 100) / 100,
};
console.error(JSON.stringify({ usage, totals, models: [...models], sandbox: bwrap ? "bwrap" : "none" }));
await new Promise<void>((done) => transcript.end(done));
writeFileSync(join(out, "usage.json"), JSON.stringify(usage));
if (report) writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
if (failure) writeFileSync(join(out, "failure.txt"), failure);
if (fix)
  writeFileSync(join(out, "fix.json"), JSON.stringify({ ...(fix as Fix), models: [...models], base: pluginHead }));
if (fixFailure) writeFileSync(join(out, "fix-failure.txt"), fixFailure);
output("usage", JSON.stringify(usage));
if (report) output("report", JSON.stringify(report));
if (failure && !report) output("failure", failure);
if (fix) output("fix", "true");
if (fixFailure) output("fix_failure", fixFailure);
process.exit(report ? 0 : 1);

function output(name: string, value: string) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const end = `EOF_${randomBytes(12).toString("hex")}`;
  appendFileSync(file, `${name}<<${end}\n${value}\n${end}\n`);
}
