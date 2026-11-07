import assert from "node:assert/strict";
import { test } from "node:test";
import { clean, MARKER, render, renderFailure, type Report } from "../scripts/upstream-watch/report.ts";
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
