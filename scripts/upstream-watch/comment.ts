// Prints the issue comment for a run of upstream-watch.ts, from what the
// Upstream workflow passes on: REPORT (its JSON) or, when there is none,
// FAILURE; USAGE; BASE, TARGET, UPSTREAM, RUN_URL and AUTO ("true" for a
// scheduled run).

import { isReport, render, renderFailure, type Run } from "./report.ts";

const env = (name: string) => process.env[name] ?? "";
const parse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};
const usage = parse(env("USAGE"));
const run: Run = {
  base: env("BASE"),
  target: env("TARGET"),
  upstream: env("UPSTREAM"),
  runUrl: env("RUN_URL"),
  auto: env("AUTO") === "true",
  usage: usage && typeof usage === "object" ? (usage as Run["usage"]) : undefined,
};
const report = parse(env("REPORT"));
process.stdout.write(
  isReport(report) ? render(report, run) : renderFailure(run, env("FAILURE") || "分析任务没交出报告（可能超时或出错）"),
);
