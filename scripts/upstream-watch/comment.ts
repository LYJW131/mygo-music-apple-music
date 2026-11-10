// Prints the issue comment for a run of upstream-watch.ts, from what the
// Upstream workflow passes on: REPORT (its JSON) or, when there is none,
// FAILURE; USAGE; BASE, TARGET, UPSTREAM, RUN_URL, AUTO ("true" for a
// scheduled run), PLUGIN_REF with PLUGIN_URL, PULL_URL or PULL_FAILURE (the
// fix's), FEATURE_URL or FEATURE_FAILURE, LIMITS ("false" when the plugin
// checked has no list of what it can't do) and PULLS (the draft pull requests
// open before the run, as JSON).

import { isReport, render, renderFailure, type OpenPull, type Run } from "./report.ts";

const env = (name: string) => process.env[name] ?? "";
const parse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};
const usage = parse(env("USAGE"));
const open = parse(env("PULLS"));
const run: Run = {
  base: env("BASE"),
  target: env("TARGET"),
  upstream: env("UPSTREAM"),
  runUrl: env("RUN_URL"),
  auto: env("AUTO") === "true",
  pull: env("PULL_URL") || undefined,
  pullFailure: env("PULL_FAILURE") || undefined,
  featurePull: env("FEATURE_URL") || undefined,
  featureFailure: env("FEATURE_FAILURE") || undefined,
  limits: env("LIMITS") !== "false",
  open: Array.isArray(open) ? (open as OpenPull[]) : undefined,
  plugin: env("PLUGIN_REF") ? { ref: env("PLUGIN_REF"), url: env("PLUGIN_URL") } : undefined,
  usage: usage && typeof usage === "object" ? (usage as Run["usage"]) : undefined,
};
const report = parse(env("REPORT"));
process.stdout.write(
  isReport(report) ? render(report, run) : renderFailure(run, env("FAILURE") || "分析任务没交出报告（可能超时或出错）"),
);
