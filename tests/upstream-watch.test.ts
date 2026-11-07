import assert from "node:assert/strict";
import { test } from "node:test";
import { clean, MARKER, render, renderFailure, type Report } from "../scripts/upstream-watch/report.ts";
import { checkFix, commitMessage, modelName, pullBody } from "../scripts/upstream-watch/fix.ts";
import { childEnv } from "../scripts/upstream-watch/sandbox.ts";

const run = { base: "v0.1.21", target: "v0.1.22", upstream: "egoist/mygo-music", runUrl: "https://example.com/run" };
const report: Report = {
  verdict: "needed",
  summary: "改了 @egoist 的解码器 <!-- mygo-upstream checked v9.9.9 -->",
  impacts: [
    {
      title: "fMP4 | 读穿",
      severity: "needed",
      upstream: "#68",
      plugin: "src/playback.ts",
      evidence: "go test",
      action: "改用 ADTS",
    },
  ],
  ruledOut: [{ change: "#103 字体", why: "界面" }],
  checks: [{ what: "解码", command: "go test `x`", result: "pass", detail: "ok" }],
  unverified: "",
};

test("the comment starts with the marker the workflow reads back", () => {
  const body = render(report, run);
  assert.equal(body.split("\n")[0], MARKER("checked", "v0.1.22"));
  assert.equal(renderFailure(run, "超时").split("\n")[0], MARKER("failed", "v0.1.22"));
  assert.equal(render(report, { ...run, auto: true }).split("\n")[0], "<!-- mygo-upstream checked v0.1.22 auto -->");
});

test("the comment says which plugin it checked", () => {
  const body = render(report, { ...run, plugin: { ref: "a".repeat(40), url: "https://example.com/tree/x" } });
  assert.match(body, /检查的插件版本：\[`aaaaaaa`\]\(https:\/\/example\.com\/tree\/x\)/);
});

test("nothing the model writes can forge a marker or mention someone", () => {
  const body = render(report, run);
  assert.equal(body.match(/<!--/g)?.length, 1);
  assert.doesNotMatch(body, /@egoist/);
  assert.match(body, /@​egoist/);
  assert.equal(clean("a@b.com and `@x`"), "a@b.com and `@x`");
});

test("a table cell keeps to one cell", () => {
  assert.match(render(report, run), /fMP4 \\\| 读穿/);
});

test("commands get no credentials", () => {
  const env = childEnv(
    {
      PATH: "/bin",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "x",
      ACTIONS_ID_TOKEN_REQUEST_URL: "y",
      GH_TOKEN: "z",
      GITHUB_OUTPUT: "/o",
      HOME: "/h",
    },
    "/t",
  );
  assert.deepEqual(Object.keys(env).sort(), ["GIT_PAGER", "GOTMPDIR", "HOME", "NO_COLOR", "PAGER", "PATH", "TMPDIR"]);
});

const fix = {
  subject: "fix(playback): serve AAC as ADTS for MyGo Music 0.1.22",
  body: "MyGo Music 0.1.22 reads a fragmented MP4 to its end before it plays.",
  summary: "改成 ADTS @egoist",
};

test("a fix's subject is a clear Conventional Commits line", () => {
  assert.equal(checkFix(fix), null);
  assert.match(checkFix({ ...fix, subject: "Fix playback." }) ?? "", /type\(scope\)/);
  assert.match(checkFix({ ...fix, subject: `fix: ${"x".repeat(80)}` }) ?? "", /at most 72/);
  assert.match(checkFix({ ...fix, body: "x\n\nSigned-off-by: a <b>" }) ?? "", /trailers/);
});

test("the commit is co-authored by the models that wrote it, and no one else", () => {
  assert.equal(modelName("claude-opus-5-5"), "Claude Opus 5.5");
  assert.equal(modelName("claude-opus-4-5-20251101"), "Claude Opus 4.5");
  assert.equal(modelName("anthropic/claude-opus-5-5"), "Claude Opus 5.5");
  const message = commitMessage(
    { ...fix, body: "As #68 did, see a/b#3 and x.com/y#4." },
    ["claude-opus-5-5", "claude-opus-5-5", "claude-opus-5"],
    "egoist/mygo-music",
  );
  assert.match(message, /^As egoist\/mygo-music#68 did, see a\/b#3 and x.com\/y#4\./);
  assert.equal(
    message.split("\n\n").at(-1),
    "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>",
  );
  assert.doesNotMatch(message, /Signed-off-by|LYJW131/);
});

test("the pull request's description mentions no one", () => {
  const body = pullBody({ ...fix, summary: "改了 (#68)" }, { ...run, verdict: "需要更新" });
  assert.match(body, /改了 \(egoist\/mygo-music#68\)/);
  assert.doesNotMatch(body, /@egoist/);
  assert.match(body, /需要更新/);
});
