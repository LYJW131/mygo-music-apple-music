// The report the model hands in, and the issue comment made from it. The
// comment's first line is a marker the workflow reads back to know which MyGo
// release was last looked at; nothing the model writes may forge one.

export const VERDICTS = ["none", "optional", "needed", "breaking"] as const;
export type Verdict = (typeof VERDICTS)[number];
const SEVERITIES = ["breaking", "needed", "optional"] as const;
const RESULTS = ["pass", "fail", "error", "skipped"] as const;
// ready: made in a pull request of its own, after the report. later: it can
// be done, but not here and now (the reason says why). unsure: it may be.
const UNLOCKED = ["ready", "later", "unsure"] as const;

export type Unlocked = {
  limit: string;
  features: string;
  upstream: string;
  plugin: string;
  evidence: string;
  status: (typeof UNLOCKED)[number];
  why: string;
};

export type Report = {
  verdict: Verdict;
  summary: string;
  impacts: {
    title: string;
    severity: (typeof SEVERITIES)[number];
    upstream: string;
    plugin: string;
    evidence: string;
    action: string;
  }[];
  ruledOut: { change: string; why: string }[];
  checks: { what: string; command: string; result: (typeof RESULTS)[number]; detail: string }[];
  unverified: string;
  unlocked: Unlocked[];
};

const text = (description: string) => ({ type: "string", description });

export const REPORT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "summary", "impacts", "ruledOut", "checks", "unverified", "unlocked"],
  properties: {
    verdict: {
      type: "string",
      enum: [...VERDICTS],
      description:
        "none: nothing to do. optional: works as is, but something could be better or newly possible. needed: something is wrong or will be, but still plays. breaking: something lyjw's listeners use is broken by this release.",
    },
    summary: text("Two to four sentences: what the release changes for the plugin, and what to do."),
    impacts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "severity", "upstream", "plugin", "evidence", "action"],
        properties: {
          title: text("A short line naming the effect."),
          severity: { type: "string", enum: [...SEVERITIES] },
          upstream: text("The MyGo change: PR numbers as #123, commits, files."),
          plugin: text("Where the plugin meets it: files and functions."),
          evidence: text("How you know: what you read and what you ran, with its result."),
          action: text("What to change in the plugin, concretely."),
        },
      },
    },
    ruledOut: {
      type: "array",
      description:
        "The MyGo changes that touch what the plugin relies on but don't affect it, so lyjw sees what was covered.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["change", "why"],
        properties: { change: text("The change, with its PR number."), why: text("One line: why it doesn't matter.") },
      },
    },
    checks: {
      type: "array",
      description: "What you ran, failures included.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["what", "command", "result", "detail"],
        properties: {
          what: text("What the check shows."),
          command: text("The command, short."),
          result: { type: "string", enum: [...RESULTS] },
          detail: text("One line of what it said."),
        },
      },
    },
    unverified: text("What you could not check here (signed-in calls, real playback…), or an empty string."),
    unlocked: {
      type: "array",
      description:
        "The entries of the plugin's list of what it can't do that this release makes possible, each by what MyGo's code now gives. Empty when none is, or when there is no list.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["limit", "features", "upstream", "plugin", "evidence", "status", "why"],
        properties: {
          limit: text("The entry's name, exactly as the list writes it in bold."),
          features: text("The rows of the comparison that it lets the plugin have."),
          upstream: text(
            "What MyGo now gives: PR numbers as #123, commits, and the files and symbols (an export, a field, a callback, a setting type).",
          ),
          plugin: text("Where the plugin would take it up: files and functions."),
          evidence: text("How you know, from the code and what you ran; a release note alone is not enough."),
          status: {
            type: "string",
            enum: [...UNLOCKED],
            description:
              "ready: you are sure, and it can be made whole and shown to work on this runner, so it will be. later: it can be done, but not completely or not verifiably here. unsure: it may be possible; you couldn't tell.",
          },
          why: text("ready: what you would make and how you'd show it works. later or unsure: why not now."),
        },
      },
    },
  },
} as const;

export function isReport(value: unknown): value is Report {
  const r = value as Report;
  return (
    !!r &&
    VERDICTS.includes(r.verdict) &&
    typeof r.summary === "string" &&
    Array.isArray(r.impacts) &&
    Array.isArray(r.ruledOut) &&
    Array.isArray(r.checks) &&
    typeof r.unverified === "string" &&
    Array.isArray(r.unlocked)
  );
}

// An open draft pull request an earlier check left, as the workflow lists
// them: the limits a feature's lifts are marked in its description.
export type OpenPull = { url: string; title: string; kind: "fix" | "feature"; limits: string[] };

export const LIMIT_MARKER = (limit: string) => `<!-- mygo-upstream limit ${limit} -->`;

// The open feature pull request that makes this entry already, if any.
export const proposedIn = (limit: string, open: OpenPull[] = []) =>
  open.find((p) => p.kind === "feature" && p.limits.includes(limit.trim()));

// What a feature is made of: the entries the model is sure of, less those an
// open pull request makes already.
export const toMake = (report: Report, open: OpenPull[] = []) =>
  report.unlocked.filter((u) => u.status === "ready" && !proposedIn(u.limit, open));

// What is wrong with the report's unlocked entries, given the list's names,
// or null. A name the list doesn't have would take nothing out of it.
export function checkUnlocked(report: Report, names: string[]): string | null {
  if (!names.length && report.unlocked.length) return "unlocked is empty: this plugin commit has no list";
  const unknown = report.unlocked.filter((u) => !names.includes(u.limit.trim())).map((u) => u.limit);
  if (unknown.length) return `unlocked names ${unknown.join(", ")}, not in the list (${names.join(", ")})`;
  return null;
}

// "auto" marks a scheduled run's comment: only those count against the daily
// limit.
export const MARKER = (state: "checked" | "failed", tag: string, auto = false) =>
  `<!-- mygo-upstream ${state} ${tag}${auto ? " auto" : ""} -->`;

const VERDICT_TEXT: Record<Verdict, string> = {
  none: "无需更新",
  optional: "可选更新",
  needed: "需要更新",
  breaking: "已有功能失效，必须更新",
};
const SEVERITY_TEXT: Record<Report["impacts"][number]["severity"], string> = {
  breaking: "已失效",
  needed: "需要改",
  optional: "可选",
};
const UNLOCKED_TEXT: Record<Unlocked["status"], string> = {
  ready: "能做",
  later: "可以做，没做",
  unsure: "不确定，没做",
};
const RESULT_TEXT: Record<Report["checks"][number]["result"], string> = {
  pass: "✅ 通过",
  fail: "❌ 失败",
  error: "⚠️ 没跑成",
  skipped: "⏭️ 跳过",
};

// The model reads MyGo's code and notes, which anyone can send a pull request
// to: what it writes must not mention people, nor carry a marker of its own.
export function clean(value: string): string {
  return value
    .replace(/<!--|-->/g, "")
    .replace(/(^|[^\w`])@(?=[\w-])/g, "$1@​")
    .replace(/\r/g, "")
    .trim();
}

// The model writes MyGo's pull requests as #68, which here would link to this
// repository's: they name MyGo's.
export const upstreamRefs = (value: string, upstream: string) =>
  value.replace(/(^|[^\w/&#])#(\d+)\b/g, `$1${upstream}#$2`);

const cell = (value: string) => clean(value).replace(/\n+/g, " ").replace(/\|/g, "\\|");

export type Run = {
  base: string;
  target: string;
  upstream: string;
  runUrl: string;
  auto?: boolean;
  // The plugin commit or tag checked, and a link to it: a report on an old
  // one says what that one needed, not what main does.
  plugin?: { ref: string; url: string };
  // The draft pull requests with the fix and the feature, or why there are
  // none.
  pull?: string;
  pullFailure?: string;
  featurePull?: string;
  featureFailure?: string;
  // false when the plugin checked has no list of what it can't do.
  limits?: boolean;
  // Draft pull requests earlier checks left open.
  open?: OpenPull[];
  usage?: Usage;
};
export type Usage = {
  model: string;
  effort: string;
  minutes: number;
  turns: number;
  toolCalls: number;
  costUsd: number;
};

export function render(report: Report, run: Run): string {
  const release = (tag: string) => `[${tag}](https://github.com/${run.upstream}/releases/tag/${tag})`;
  const lines = [
    MARKER("checked", run.target, run.auto),
    `## MyGo Music ${release(run.base)} → ${release(run.target)}：${VERDICT_TEXT[report.verdict]}`,
    "",
    ...pluginLine(run),
    clean(report.summary),
    ...pullLine(run),
  ];
  if (report.impacts.length) {
    lines.push("", "### 影响");
    report.impacts.forEach((impact, i) => {
      lines.push(
        "",
        `${i + 1}. **${cell(impact.title)}**（${SEVERITY_TEXT[impact.severity]}）`,
        `   - 上游：${cell(impact.upstream)}`,
        `   - 插件：${cell(impact.plugin)}`,
        `   - 依据：${cell(impact.evidence)}`,
        `   - 建议：${cell(impact.action)}`,
      );
    });
  }
  lines.push("", ...unlockedLines(report, run));
  if (report.ruledOut.length) {
    lines.push("", "<details><summary>已排查、不受影响（" + report.ruledOut.length + "）</summary>", "");
    for (const item of report.ruledOut) lines.push(`- ${cell(item.change)}：${cell(item.why)}`);
    lines.push("", "</details>");
  }
  if (report.checks.length) {
    lines.push("", "<details><summary>跑过的检查（" + report.checks.length + "）</summary>", "");
    lines.push("| 检查 | 结果 | 说明 |", "| --- | --- | --- |");
    for (const check of report.checks)
      lines.push(
        `| ${cell(check.what)}<br>\`${cell(check.command).replace(/`/g, "'")}\` | ${RESULT_TEXT[check.result]} | ${cell(check.detail)} |`,
      );
    lines.push("", "</details>");
  }
  if (clean(report.unverified)) lines.push("", `没验证到：${cell(report.unverified)}`);
  lines.push("", footer(run));
  return limit(upstreamRefs(lines.join("\n"), run.upstream));
}

export function renderFailure(run: Run, reason: string): string {
  return limit(
    [
      MARKER("failed", run.target, run.auto),
      `## MyGo Music ${run.base} → ${run.target}：没检查完`,
      "",
      `${clean(reason)}。这个版本不会自动重试；手动运行工作流（填 target）可以再查一次。`,
      "",
      footer(run),
    ].join("\n"),
  );
}

function pullLine(run: Run): string[] {
  const lines: string[] = [];
  if (run.pull) lines.push("", `**修复草稿 PR：${run.pull}**`);
  else if (run.pullFailure) lines.push("", `没生成修复草稿 PR：${cell(run.pullFailure)}`);
  if (run.featurePull) lines.push("", `**新功能草稿 PR：${run.featurePull}**`);
  else if (run.featureFailure) lines.push("", `没生成新功能草稿 PR：${cell(run.featureFailure)}`);
  return lines;
}

// Whether the release lifts an entry of the plugin's list of what it can't
// do, said either way.
function unlockedLines(report: Report, run: Run): string[] {
  const lines = ["### 这次更新让哪些原来做不到的功能做得到了", ""];
  if (run.limits === false) return [...lines, "检查的插件版本里没有「插件方案的限制」清单，这一项没查。"];
  if (!report.unlocked.length) return [...lines, "没有：这次更新没有解除「插件方案的限制」里的任何一条。"];
  report.unlocked.forEach((u, i) => {
    const open = proposedIn(u.limit, run.open);
    lines.push(
      ...(i ? [""] : []),
      `${i + 1}. **${cell(u.limit)}**（${UNLOCKED_TEXT[u.status]}）`,
      `   - 功能：${cell(u.features)}`,
      `   - 上游：${cell(u.upstream)}`,
      `   - 插件：${cell(u.plugin)}`,
      `   - 依据：${cell(u.evidence)}`,
      `   - ${u.status === "ready" ? "做法" : "原因"}：${cell(u.why)}`,
      ...(u.status === "ready" && open ? [`   - 已有草稿 PR：${open.url}，这次没再做`] : []),
    );
  });
  return lines;
}

function pluginLine(run: Run): string[] {
  if (!run.plugin) return [];
  const ref = /^[0-9a-f]{40}$/.test(run.plugin.ref) ? run.plugin.ref.slice(0, 7) : run.plugin.ref;
  return [`检查的插件版本：[\`${cell(ref).replace(/`/g, "")}\`](${run.plugin.url})`, ""];
}

function footer(run: Run): string {
  const u = run.usage;
  const cost = u
    ? ` · ${u.model}（effort ${u.effort}）· ${u.minutes} 分钟 · ${u.toolCalls} 次工具调用 · 约 $${u.costUsd}`
    : "";
  return `<sub>[运行记录](${run.runUrl})${cost}</sub>`;
}

// GitHub refuses comments over 65536 characters.
function limit(body: string): string {
  return body.length <= 60_000 ? body : `${body.slice(0, 60_000)}\n\n…（太长，已截断）`;
}
