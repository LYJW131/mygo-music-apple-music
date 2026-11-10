// Proposes what upstream-watch.ts made as draft pull requests: the fix and
// the feature each on a branch of its own from the plugin commit checked, one
// commit on it made through GitHub's createCommitOnBranch, which GitHub signs
// as the app whose token makes it (lyjw131[bot]; a commit pushed with git from
// the runner would be unsigned), and a draft pull request into the branch that
// commit came from. When a run makes both, each pull request links the other.
//
// From the Upstream workflow: GH_TOKEN (the app's, contents and pull requests
// write), GITHUB_REPOSITORY, DIR (the run's files: fix.json and
// fix-changes.json, feature.json and feature-changes.json, report.json),
// BASE_BRANCH, BASE, TARGET, UPSTREAM, RUN_URL, ISSUE. Writes fix_url or
// fix_failure, and feature_url or feature_failure, to GITHUB_OUTPUT.

import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { commitMessage, plan, pullBody, type Context, type Fix, type Kind } from "./fix.ts";
import type { Report } from "./report.ts";

type Made = Fix & { models: string[]; base: string; limits?: string[]; e2e?: string[] };

const env = (name: string) => process.env[name] || fail(`${name} isn't set`);
const repo = env("GITHUB_REPOSITORY");
const dir = env("DIR");
const read = <T>(name: string) => JSON.parse(readFileSync(join(dir, name), "utf8")) as T;
const made: Partial<Record<Kind, Made>> = {};
for (const kind of ["fix", "feature"] as const)
  if (existsSync(join(dir, `${kind}.json`))) made[kind] = read<Made>(`${kind}.json`);
const report = read<Report>("report.json");
const baseBranch = env("BASE_BRANCH");
const target = env("TARGET");
const VERDICT_TEXT: Record<string, string> = {
  none: "无需更新",
  optional: "可选更新",
  needed: "需要更新",
  breaking: "已有功能失效，必须更新",
};

// missing: a missing ref answers 404 to some calls and 422 to a DELETE.
async function github<T>(method: string, path: string, body?: unknown, missing = false): Promise<T | null> {
  const res = await fetch(`https://api.github.com/${path}`, {
    method,
    headers: {
      authorization: `Bearer ${env("GH_TOKEN")}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  if (missing && (res.status === 404 || res.status === 422)) return null;
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
  const json = text ? (JSON.parse(text) as T & { errors?: { message: string }[] }) : null;
  if (json?.errors?.length) throw new Error(`${path}: ${json.errors.map((e) => e.message).join("; ")}`);
  return json;
}

const context = (kind: Kind, other?: string): Context => ({
  kind,
  base: env("BASE"),
  target,
  upstream: env("UPSTREAM"),
  runUrl: env("RUN_URL"),
  verdict: VERDICT_TEXT[report.verdict] ?? report.verdict,
  limits: made[kind]?.limits,
  e2e: made[kind]?.e2e,
  other,
  issueUrl: process.env.ISSUE ? `https://github.com/${repo}/issues/${process.env.ISSUE}` : undefined,
});

type Opened = { number: number; url: string; fresh: boolean };

async function propose(kind: Kind, branch: string, title: string): Promise<Opened> {
  const change = made[kind]!;
  // A pull request open for this release and kind already is the one: a run
  // again by hand doesn't open a second.
  const owner = repo.split("/")[0];
  const open = await github<{ number: number; html_url: string }[]>(
    "GET",
    `repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`,
  );
  if (open?.length) {
    console.log(`Open already: ${open[0]!.html_url}`);
    return { number: open[0]!.number, url: open[0]!.html_url, fresh: false };
  }
  let created = false;
  let committed = false;
  try {
    await github("DELETE", `repos/${repo}/git/refs/heads/${branch}`, undefined, true);
    await github("POST", `repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: change.base });
    created = true;
    const commit = await github<{ data: { createCommitOnBranch: { commit: { oid: string; url: string } } } }>(
      "POST",
      "graphql",
      {
        query:
          "mutation($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid url } } }",
        variables: {
          input: {
            branch: { repositoryNameWithOwner: repo, branchName: branch },
            expectedHeadOid: change.base,
            message: { headline: title, body: commitMessage(change, change.models, env("UPSTREAM")) },
            fileChanges: read<object>(`${kind}-changes.json`),
          },
        },
      },
    );
    committed = true;
    console.log(`Committed ${commit!.data.createCommitOnBranch.commit.url}`);
    const pull = await github<{ number: number; html_url: string }>("POST", `repos/${repo}/pulls`, {
      title,
      head: branch,
      base: baseBranch,
      draft: true,
      body: pullBody(change, context(kind)),
    });
    await github("POST", `repos/${repo}/issues/${pull!.number}/labels`, { labels: ["Automation"] });
    console.log(`Opened ${pull!.html_url}`);
    return { number: pull!.number, url: pull!.html_url, fresh: true };
  } catch (error) {
    // A branch with nothing on it would only be in the way.
    if (created && !committed)
      await github("DELETE", `repos/${repo}/git/refs/heads/${branch}`, undefined, true).catch(() => {});
    throw error;
  }
}

const opened: Partial<Record<Kind, Opened>> = {};
for (const { kind, branch, title } of plan(target, made)) {
  try {
    opened[kind] = await propose(kind, branch, title);
    output(`${kind}_url`, opened[kind]!.url);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`::error::${kind}: ${message}`);
    output(`${kind}_failure`, message);
  }
}

// Each names the other once both are open; one an earlier run opened keeps
// what it says.
const { fix, feature } = opened;
if (fix && feature)
  for (const [kind, self, other] of [
    ["fix", fix, feature],
    ["feature", feature, fix],
  ] as const)
    if (self.fresh)
      await github("PATCH", `repos/${repo}/pulls/${self.number}`, {
        body: pullBody(made[kind]!, context(kind, other.url)),
      }).catch((error) => console.log(`::warning::${kind}: ${(error as Error).message}`));

function output(name: string, value: string) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const end = `EOF_${randomBytes(12).toString("hex")}`;
  appendFileSync(file, `${name}<<${end}\n${value}\n${end}\n`);
}

function fail(message: string): never {
  throw new Error(message);
}
