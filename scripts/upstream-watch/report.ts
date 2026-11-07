// The report the model hands in, and the issue comment made from it. The
// comment's first line is a marker the workflow reads back to know which MyGo
// release was last looked at; nothing the model writes may forge one.

export const VERDICTS = ["none", "optional", "needed", "breaking"] as const;
export type Verdict = (typeof VERDICTS)[number];
const SEVERITIES = ["breaking", "needed", "optional"] as const;
const RESULTS = ["pass", "fail", "error", "skipped"] as const;

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
};

const text = (description: string) => ({ type: "string", description });

export const REPORT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "summary", "impacts", "ruledOut", "checks", "unverified"],
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
    typeof r.unverified === "string"
  );
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
  return limit(lines.join("\n"));
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
