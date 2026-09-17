/**
 * 端口模式失败清单对比（回归定位工具）
 *
 * 用途：改动前后各跑一次 `vitest run --reporter=json --outputFile=...`，
 * 再用本工具列出**新增失败**与**新修复**的用例名。
 *
 * 为什么需要它：端口模式的失败数在迁移期是**已知不零**的（旧基座里大量
 * "测试直接读写旧库"的用例）。只看总数无法判断"这次改动是不是打红了新的东西"
 * —— 实测：改动后 91 → 94，其中 3 个来自上一批（settings.ts），本批 0 个。
 * 没有这份对比就只能靠感觉，而感觉在这个仓库里已经错过好几次。
 *
 * 用法：node tools/audit/port-diff.mjs <before.json> <after.json>
 */
import { readFileSync } from "node:fs";

const [, , beforePath, afterPath] = process.argv;
if (!beforePath || !afterPath) {
  console.error("用法：node tools/audit/port-diff.mjs <before.json> <after.json>");
  process.exit(2);
}

/** 把 vitest json 报告摊平成 "文件 > 用例名" 集合（只取失败） */
function failingSet(path) {
  const report = JSON.parse(readFileSync(path, "utf8"));
  const out = new Map();
  for (const file of report.testResults ?? []) {
    const name = String(file.name).replace(/.*[\\/]/, "");
    for (const a of file.assertionResults ?? []) {
      if (a.status === "failed") out.set(`${name} > ${a.fullName ?? a.title}`, a.failureMessages?.[0] ?? "");
    }
  }
  return { report, out };
}

const before = failingSet(beforePath);
const after = failingSet(afterPath);

const added = [...after.out.keys()].filter((k) => !before.out.has(k));
const fixed = [...before.out.keys()].filter((k) => !after.out.has(k));

console.log(`改动前：失败 ${before.report.numFailedTests} / 通过 ${before.report.numPassedTests}`);
console.log(`改动后：失败 ${after.report.numFailedTests} / 通过 ${after.report.numPassedTests}`);
console.log(`净变化：${after.report.numFailedTests - before.report.numFailedTests >= 0 ? "+" : ""}${after.report.numFailedTests - before.report.numFailedTests}`);
console.log("");
if (added.length) {
  console.log(`⚠️ 新增失败 ${added.length} 个：`);
  for (const k of added) {
    const msg = after.out.get(k).split("\n").find((l) => l.trim()) ?? "";
    console.log(`  - ${k}`);
    console.log(`      ${msg.trim().slice(0, 200)}`);
  }
} else {
  console.log("✅ 无新增失败");
}
if (fixed.length) {
  console.log("");
  console.log(`✅ 新修复 ${fixed.length} 个：`);
  for (const k of fixed) console.log(`  - ${k}`);
}
