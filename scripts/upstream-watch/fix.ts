// When the report says the plugin needs a change, the model makes it, and
// lyjw131[bot] proposes it as a draft pull request of one commit; when the
// release lifts something the plugin couldn't do, the feature is another, on
// a branch of its own. This is what the model hands in for each, and the
// commit message and pull request made from that.

import { clean, LIMIT_MARKER, upstreamRefs } from "./report.ts";

export type Fix = { subject: string; body: string; summary: string };
export type Kind = "fix" | "feature";

const text = (description: string) => ({ type: "string", description });

export const FIX_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["subject", "body", "summary"],
  properties: {
    subject: text(
      "The commit's subject, which is also the pull request's title: Conventional Commits as the plugin's CLAUDE.md says, in English, lower case, no full stop, at most 72 characters. Say what changes and for which MyGo Music release, so it reads clearly in a list. A fix is any type but feat, e.g. `fix(lyrics): send word timings as MyGo Music 0.3.0 reads them`; a feature is feat, e.g. `feat(activity): report pauses and seeks through MyGo Music 0.3.0`.",
    ),
    body: text(
      "The commit body, in English: what changed and why, in plain sentences, wrapped at 72 columns. No trailers; they are added.",
    ),
    summary: text(
      "The pull request's description, in Simplified Chinese, for lyjw reading on a phone: what changed and why, and what you ran to check it, with the results. Short.",
    ),
  },
} as const;

export function isFix(value: unknown): value is Fix {
  const f = value as Fix;
  return !!f && typeof f.subject === "string" && typeof f.body === "string" && typeof f.summary === "string";
}

const SUBJECT = /^(feat|fix|perf|refactor|docs|test|build|ci|chore)(\([a-z0-9-]+\))?: [^A-Z\s].*[^.\s]$/;

// What is wrong with a change's message, or null. A feature's type is feat
// and a fix's isn't, so the two pull requests' titles tell them apart.
export function checkFix(fix: Fix, kind: Kind = "fix"): string | null {
  const subject = fix.subject.trim();
  if (subject.includes("\n")) return "subject is one line";
  if (subject.length > 72) return `subject is ${subject.length} characters; at most 72`;
  if (!SUBJECT.test(subject)) return "subject reads `type(scope): summary`, lower case, no full stop";
  const feat = /^feat\b/.test(subject);
  if (kind === "feature" && !feat) return "a feature's subject is `feat(scope): summary`";
  if (kind === "fix" && feat) return "a fix's subject isn't feat; that is for features";
  if (!fix.body.trim()) return "body says what changed and why";
  if (/^(Co-Authored-By|Signed-off-by):/im.test(fix.body)) return "body has no trailers; they are added";
  if (!fix.summary.trim()) return "summary is the pull request's description";
  return null;
}

// claude-opus-5-5 → Claude Opus 5.5; a dated id loses its date, and a
// gateway's provider/ prefix goes.
export function modelName(id: string): string {
  const words = id
    .replace(/^.*\//, "")
    .replace(/-\d{8}$/, "")
    .split("-");
  const numbers = words.filter((w) => /^\d+$/.test(w));
  const names = words.filter((w) => !/^\d+$/.test(w)).map((w) => w[0]!.toUpperCase() + w.slice(1));
  return [...names, numbers.join(".")].filter(Boolean).join(" ");
}

// The models that wrote it are its co-authors, and no one else: the commit is
// lyjw131[bot]'s, and lyjw reviews it.
export function commitMessage(fix: Fix, models: string[], upstream: string): string {
  const authors = [...new Set(models.map(modelName))].map((name) => `Co-Authored-By: ${name} <noreply@anthropic.com>`);
  return `${upstreamRefs(fix.body.replace(/\r/g, "").trim(), upstream)}\n\n${authors.join("\n")}`;
}

// Each kind's branch, named by the MyGo release it was made for. A run again
// for the same release finds its pull request open on it.
export const branchFor = (kind: Kind, target: string) =>
  kind === "fix" ? `upstream/mygo-${target}` : `upstream/mygo-${target}-feature`;

// The pull requests a run opens: the fix first, then the feature, each on its
// own branch from the plugin commit checked.
export function plan(target: string, made: Partial<Record<Kind, Fix>>) {
  return (["fix", "feature"] as const).flatMap((kind) => {
    const change = made[kind];
    return change ? [{ kind, branch: branchFor(kind, target), title: change.subject.trim() }] : [];
  });
}

export type Context = {
  kind: Kind;
  base: string;
  target: string;
  upstream: string;
  runUrl: string;
  // The fix's: the check's verdict, in lyjw's words.
  verdict?: string;
  // The feature's: the entries of the list it lifts, and the MyGo versions
  // the end-to-end test played it in.
  limits?: string[];
  e2e?: string[];
  // The other pull request this run opened.
  other?: string;
  issueUrl?: string;
};

export function pullBody(fix: Fix, c: Context): string {
  const release = (tag: string) => `[${tag}](https://github.com/${c.upstream}/releases/tag/${tag})`;
  const limits = (c.limits ?? []).map((l) => `「${l}」`).join("");
  const head =
    c.kind === "fix"
      ? `**修复** · MyGo Music ${release(c.base)} → ${release(c.target)} 的检查结论是“${c.verdict}”。`
      : `**新功能** · MyGo Music ${release(c.target)} 新给的接口让插件做得到${limits}里原来做不到的事。`;
  const checked =
    c.kind === "fix"
      ? "这是 Claude 按检查结果写的修改，跑过 `npm run check`。"
      : `这是 Claude 按检查结果做的新功能，跑过 \`npm run check\`${c.e2e?.length ? `和端到端测试（MyGo ${c.e2e.join("、")}）` : ""}，README 的限制清单和对照表一并改了。`;
  const other = c.other
    ? `同一次检查的${c.kind === "fix" ? "新功能" : "修复"} PR：${c.other}。两个 PR 都从同一个插件提交开出，互不包含。`
    : "";
  const lines = [
    head,
    "",
    upstreamRefs(clean(fix.summary), c.upstream),
    "",
    "---",
    "",
    `${checked}草稿，合并前请审阅。${other}`,
    "",
    `<sub>${c.issueUrl ? `[检查报告](${c.issueUrl}) · ` : ""}[运行记录](${c.runUrl})</sub>`,
    // The workflow reads these back so a later check doesn't make it again.
    ...(c.kind === "feature" ? ["", ...(c.limits ?? []).map(LIMIT_MARKER)] : []),
  ];
  return lines.join("\n");
}
