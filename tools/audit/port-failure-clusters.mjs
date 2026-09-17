/**
 * 把端口模式失败按**错误签名**聚类（第 13 轮：清零 74 个失败的第一步）。
 *
 * 为什么先聚类而不是逐个修：74 个失败可能是 3~5 个共同原因（例如"测试直接读旧库"
 * 这一类会横跨十几个文件）。先看清"有几种病"，再决定修哪几种 —— 逐个修会重复劳动，
 * 而且容易把同一类问题在多个文件里各修一遍（漏掉一处就又不一致）。
 *
 * 用法：node tools/audit/port-failure-clusters.mjs <vitest-json-report>
 */
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("用法：node tools/audit/port-failure-clusters.mjs <report.json>");
  process.exit(2);
}
const report = JSON.parse(readFileSync(file, "utf8"));

/** 把一条失败信息压成"签名"：去掉具体数值/标识，只留结构性特征 */
function signature(msg) {
  return String(msg ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("at ") && !l.startsWith("❯"))
    .slice(0, 2)
    .join(" | ")
    .replace(/\d+/g, "N")
    .replace(/'[^']{0,60}'/g, "'X'")
    .slice(0, 160);
}

const clusters = new Map();
for (const t of report.testResults ?? []) {
  if (t.status === "passed") continue;
  const name = String(t.name).replace(/.*[\\/]/, "");
  for (const a of t.assertionResults ?? []) {
    if (a.status !== "failed") continue;
    const sig = signature(a.failureMessages?.[0]);
    const list = clusters.get(sig) ?? [];
    list.push(`${name} :: ${a.title}`);
    clusters.set(sig, list);
  }
}

const sorted = [...clusters.entries()].sort((a, b) => b[1].length - a[1].length);
console.log(`失败 ${report.numFailedTests} 个，聚成 ${sorted.length} 类\n`);
for (const [sig, tests] of sorted) {
  console.log(`── ${tests.length} 个 ──`);
  console.log(`   ${sig}`);
  for (const t of tests.slice(0, 4)) console.log(`     · ${t}`);
  if (tests.length > 4) console.log(`     · …还有 ${tests.length - 4} 个`);
  console.log("");
}
