// When the report says the plugin needs a change, the model makes it, and
// lyjw131[bot] proposes it as a draft pull request of one commit. This is what
// the model hands in for it, and the commit message and pull request made from
// that.

import { clean, upstreamRefs } from "./report.ts";

export type Fix = { subject: string; body: string; summary: string };

const text = (description: string) => ({ type: "string", description });

export const FIX_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["subject", "body", "summary"],
  properties: {
    subject: text(
      "The commit's subject, which is also the pull request's title: Conventional Commits as the plugin's CLAUDE.md says, in English, lower case, no full stop, at most 72 characters. Say what changes and for which MyGo Music release, so it reads clearly in a list, e.g. `fix(playback): serve AAC as ADTS for MyGo Music 0.1.22`.",
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

// What is wrong with a fix's message, or null.
export function checkFix(fix: Fix): string | null {
  const subject = fix.subject.trim();
  if (subject.includes("\n")) return "subject is one line";
  if (subject.length > 72) return `subject is ${subject.length} characters; at most 72`;
  if (!SUBJECT.test(subject)) return "subject reads `type(scope): summary`, lower case, no full stop";
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

export type Context = {
  base: string;
  target: string;
  upstream: string;
  runUrl: string;
  verdict: string;
  issueUrl?: string;
};

export function pullBody(fix: Fix, c: Context): string {
  const release = (tag: string) => `[${tag}](https://github.com/${c.upstream}/releases/tag/${tag})`;
  const lines = [
    upstreamRefs(clean(fix.summary), c.upstream),
    "",
    "---",
    "",
    `MyGo Music ${release(c.base)} → ${release(c.target)} 的检查结论是“${c.verdict}”，这是 Claude 按检查结果写的修改，跑过 \`npm run check\`。草稿，合并前请审阅。`,
    "",
    `<sub>${c.issueUrl ? `[检查报告](${c.issueUrl}) · ` : ""}[运行记录](${c.runUrl})</sub>`,
  ];
  return lines.join("\n");
}
