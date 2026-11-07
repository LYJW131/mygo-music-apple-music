// Proposes the fix upstream-watch.ts made as a draft pull request: a branch
// from the plugin commit checked, one commit on it made through GitHub's
// createCommitOnBranch, which GitHub signs as the app whose token makes it
// (lyjw131[bot]; a commit pushed with git from the runner would be unsigned),
// and a draft pull request into the branch that commit came from.
//
// From the Upstream workflow: GH_TOKEN (the app's, contents and pull requests
// write), GITHUB_REPOSITORY, DIR (the run's files: fix.json, changes.json,
// report.json), BASE_BRANCH, BASE, TARGET, UPSTREAM, RUN_URL, ISSUE. Writes
// url, or failure, to GITHUB_OUTPUT.

import { randomBytes } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { commitMessage, pullBody, type Fix } from "./fix.ts";
import type { Report } from "./report.ts";

const env = (name: string) => process.env[name] || fail(`${name} isn't set`);
const repo = env("GITHUB_REPOSITORY");
const dir = env("DIR");
const read = <T>(name: string) => JSON.parse(readFileSync(join(dir, name), "utf8")) as T;
const fix = read<Fix & { models: string[]; base: string }>("fix.json");
const changes = read<object>("changes.json");
const report = read<Report>("report.json");
const baseBranch = env("BASE_BRANCH");
const target = env("TARGET");
const branch = `upstream/mygo-${target}`;
const VERDICT_TEXT: Record<string, string> = { needed: "需要更新", breaking: "已有功能失效，必须更新" };

async function github<T>(method: string, path: string, body?: unknown, allow404 = false): Promise<T | null> {
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
  if (allow404 && res.status === 404) return null;
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
  const json = text ? (JSON.parse(text) as T & { errors?: { message: string }[] }) : null;
  if (json?.errors?.length) throw new Error(`${path}: ${json.errors.map((e) => e.message).join("; ")}`);
  return json;
}

let made = false;
let committed = false;
try {
  // A pull request open for this release already is the one: a run again by
  // hand doesn't open a second.
  const owner = repo.split("/")[0];
  const open = await github<{ html_url: string }[]>(
    "GET",
    `repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`,
  );
  if (open?.length) {
    console.log(`Open already: ${open[0]!.html_url}`);
    output("url", open[0]!.html_url);
    process.exit(0);
  }
  await github("DELETE", `repos/${repo}/git/refs/heads/${branch}`, undefined, true);
  await github("POST", `repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: fix.base });
  made = true;
  const commit = await github<{ data: { createCommitOnBranch: { commit: { oid: string; url: string } } } }>(
    "POST",
    "graphql",
    {
      query:
        "mutation($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid url } } }",
      variables: {
        input: {
          branch: { repositoryNameWithOwner: repo, branchName: branch },
          expectedHeadOid: fix.base,
          message: { headline: fix.subject.trim(), body: commitMessage(fix, fix.models) },
          fileChanges: changes,
        },
      },
    },
  );
  committed = true;
  console.log(`Committed ${commit!.data.createCommitOnBranch.commit.url}`);
  const pull = await github<{ number: number; html_url: string }>("POST", `repos/${repo}/pulls`, {
    title: fix.subject.trim(),
    head: branch,
    base: baseBranch,
    draft: true,
    body: pullBody(fix, {
      base: env("BASE"),
      target,
      upstream: env("UPSTREAM"),
      runUrl: env("RUN_URL"),
      verdict: VERDICT_TEXT[report.verdict] ?? report.verdict,
      issueUrl: process.env.ISSUE ? `https://github.com/${repo}/issues/${process.env.ISSUE}` : undefined,
    }),
  });
  await github("POST", `repos/${repo}/issues/${pull!.number}/labels`, { labels: ["Automation"] });
  console.log(`Opened ${pull!.html_url}`);
  output("url", pull!.html_url);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.log(`::error::${message}`);
  // A branch with nothing on it would only be in the way.
  if (made && !committed)
    await github("DELETE", `repos/${repo}/git/refs/heads/${branch}`, undefined, true).catch(() => {});
  output("failure", message);
}

function output(name: string, value: string) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const end = `EOF_${randomBytes(12).toString("hex")}`;
  appendFileSync(file, `${name}<<${end}\n${value}\n${end}\n`);
}

function fail(message: string): never {
  throw new Error(message);
}
