import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  checkUnlocked,
  clean,
  LIMIT_MARKER,
  MARKER,
  render,
  renderFailure,
  toMake,
  type OpenPull,
  type Report,
  type Unlocked,
} from "../scripts/upstream-watch/report.ts";
import { checkFix, commitMessage, modelName, plan, pullBody } from "../scripts/upstream-watch/fix.ts";
import { worst } from "../scripts/upstream-watch/breakers.ts";
import { limitEntry, limitNames, limitsSection, reasonsGiven } from "../scripts/upstream-watch/limits.ts";
import { childEnv } from "../scripts/upstream-watch/sandbox.ts";

const file = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

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
  unlocked: [],
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
  const body = pullBody({ ...fix, summary: "改了 (#68)" }, { ...run, kind: "fix", verdict: "需要更新" });
  assert.match(body, /改了 \(egoist\/mygo-music#68\)/);
  assert.doesNotMatch(body, /@egoist/);
  assert.match(body, /需要更新/);
});

const feature = {
  subject: "feat(activity): report pauses and seeks through MyGo Music 0.1.22",
  body: "MyGo Music 0.1.22 tells a plugin when a song is paused.",
  summary: "上报暂停和拖动",
};

const unlocked = (limit: string, status: Unlocked["status"]): Unlocked => ({
  limit,
  features: "暂停、继续、拖动、播完、退出",
  upstream: "internal/plugin/host.go `paused`",
  plugin: "src/activity.ts",
  evidence: "读了 host.go",
  status,
  why: "加导出 paused",
});

test("the check reads the list of what the plugin can't do from the README, and every reason the comparison gives is on it", () => {
  for (const readme of ["README.md", "README.en.md"]) {
    const section = limitsSection(file(readme));
    assert.ok(section, `${readme} has no list`);
    const names = limitNames(section);
    assert.ok(names.length > 0);
    for (const reason of reasonsGiven(section)) assert.ok(names.includes(reason), `${readme}: ${reason} isn't listed`);
  }
  const section = limitsSection(file("README.md"))!;
  assert.ok(limitNames(section).includes("播放事件"));
  assert.doesNotMatch(section, /跟随 MyGo Music 更新/);
  assert.equal(limitsSection("# Apple Music\n\n## 功能\n"), null);
});

test("a feature lifts the entries it took out of the list or rewrote, and no others", () => {
  for (const readme of ["README.md", "README.en.md"]) {
    const section = limitsSection(file(readme))!;
    const [name, other] = limitNames(section);
    const entry = limitEntry(section, name!)!;
    assert.ok(entry.length > 20);
    const rewritten = section.replace(entry, `- **${name}**: still missing pauses`);
    assert.notEqual(limitEntry(rewritten, name!), entry);
    assert.equal(limitEntry(rewritten, other!), limitEntry(section, other!));
    assert.equal(limitEntry(section.replace(`${entry}\n`, ""), name!), null);
  }
});

test("the comment says whether the release lifts any of what the plugin can't do", () => {
  assert.match(render(report, run), /### 这次更新让哪些原来做不到的功能做得到了\n\n没有：/);
  assert.match(render(report, { ...run, limits: false }), /没有「插件方案的限制」清单，这一项没查/);
  const open: OpenPull[] = [
    { url: "https://example.com/pull/7", title: "feat: x", kind: "feature", limits: ["自动播放"] },
  ];
  const body = render(
    {
      ...report,
      unlocked: [unlocked("播放事件", "ready"), unlocked("自动播放", "ready"), unlocked("歌词", "unsure")],
    },
    { ...run, open, featurePull: "https://example.com/pull/9" },
  );
  assert.match(body, /1\. \*\*播放事件\*\*（能做）\n {3}- 功能：暂停/);
  assert.match(body, /2\. \*\*自动播放\*\*（能做）[^]*已有草稿 PR：https:\/\/example\.com\/pull\/7，这次没再做/);
  assert.match(body, /3\. \*\*歌词\*\*（不确定，没做）[^]*原因：加导出 paused/);
  assert.match(body, /\*\*新功能草稿 PR：https:\/\/example\.com\/pull\/9\*\*/);
  assert.match(
    render(report, { ...run, pull: "a", featureFailure: "没开" }),
    /修复草稿 PR：a[^]*没生成新功能草稿 PR：没开/,
  );
});

test("only what the model is sure of, and no open pull request makes, is made", () => {
  const open: OpenPull[] = [{ url: "u", title: "feat: x", kind: "feature", limits: ["自动播放"] }];
  const r = {
    ...report,
    unlocked: [
      unlocked("播放事件", "ready"),
      unlocked("自动播放", "ready"),
      unlocked("歌词", "later"),
      unlocked("音频格式", "unsure"),
    ],
  };
  assert.deepEqual(
    toMake(r, open).map((u) => u.limit),
    ["播放事件"],
  );
  // A fix pull request open doesn't hold a feature back.
  assert.equal(toMake(r, [{ ...open[0]!, kind: "fix" }]).length, 2);
});

test("a report names only entries the list has", () => {
  const r = { ...report, unlocked: [unlocked("播放事件", "ready")] };
  assert.equal(checkUnlocked(r, ["播放事件", "歌词"]), null);
  assert.match(checkUnlocked({ ...r, unlocked: [unlocked("播放", "ready")] }, ["播放事件"]) ?? "", /not in the list/);
  assert.match(checkUnlocked(r, []) ?? "", /no list/);
  assert.equal(checkUnlocked(report, []), null);
});

test("a fix and a feature each get a pull request of their own, the fix first", () => {
  assert.deepEqual(plan("v0.1.22", {}), []);
  assert.deepEqual(plan("v0.1.22", { fix }), [{ kind: "fix", branch: "upstream/mygo-v0.1.22", title: fix.subject }]);
  assert.deepEqual(plan("v0.1.22", { feature }), [
    { kind: "feature", branch: "upstream/mygo-v0.1.22-feature", title: feature.subject },
  ]);
  assert.deepEqual(
    plan("v0.1.22", { feature, fix }).map((p) => [p.kind, p.branch]),
    [
      ["fix", "upstream/mygo-v0.1.22"],
      ["feature", "upstream/mygo-v0.1.22-feature"],
    ],
  );
});

test("a feature's title is feat and a fix's isn't, so the two read apart", () => {
  assert.equal(checkFix(feature, "feature"), null);
  assert.match(checkFix(fix, "feature") ?? "", /feature's subject is `feat/);
  assert.match(checkFix(feature, "fix") ?? "", /fix's subject isn't feat/);
});

test("the two pull requests say which they are, name each other, and a feature marks what it lifts", () => {
  const context = { ...run, verdict: "需要更新", other: "https://example.com/pull/2" };
  const fixBody = pullBody(fix, { ...context, kind: "fix" });
  const featureBody = pullBody(feature, {
    ...context,
    kind: "feature",
    limits: ["播放事件"],
    e2e: ["0.1.21", "0.1.22"],
  });
  assert.match(fixBody, /^\*\*修复\*\*/);
  assert.match(fixBody, /同一次检查的新功能 PR：https:\/\/example\.com\/pull\/2/);
  assert.doesNotMatch(fixBody, /mygo-upstream limit/);
  assert.match(featureBody, /^\*\*新功能\*\*[^\n]*「播放事件」/);
  assert.match(featureBody, /同一次检查的修复 PR：https:\/\/example\.com\/pull\/2/);
  assert.match(featureBody, /端到端测试（MyGo 0\.1\.21、0\.1\.22）/);
  assert.equal(featureBody.split("\n").at(-1), LIMIT_MARKER("播放事件"));
});

test("the workflow's breakers: each phase's own, and a step timeout past all three", () => {
  const workflow = file(".github/workflows/upstream.yml");
  const flag = (name: string) => Number(workflow.match(new RegExp(`--${name} (\\d+)`))?.[1]);
  const phases = {
    check: { minutes: flag("minutes"), dollars: flag("dollars") },
    fix: { minutes: flag("fix-minutes"), dollars: flag("fix-dollars") },
    feature: { minutes: flag("feature-minutes"), dollars: flag("feature-dollars") },
  };
  assert.deepEqual(phases, {
    check: { minutes: 30, dollars: 20 },
    fix: { minutes: 20, dollars: 20 },
    feature: { minutes: 20, dollars: 20 },
  });
  const most = worst(Object.values(phases));
  assert.deepEqual(most, { minutes: 105, dollars: 90 });
  const step = Number(workflow.match(/- id: watch\n\s+continue-on-error: true\n\s+timeout-minutes: (\d+)/)?.[1]);
  const job = Number(workflow.match(/analyze:[^]*?timeout-minutes: (\d+)/)?.[1]);
  assert.ok(step >= most.minutes + 5, `the watch step's ${step} minutes don't outlast the phases' ${most.minutes}`);
  assert.ok(job > step);
  assert.match(workflow, /DAILY_RUNS: 3\n/);
});
