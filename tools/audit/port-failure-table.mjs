/**
 * 把端口模式下的失败清单渲染成 Markdown 表格（P5 删除工作待办清单）。
 * 用法：node tools/audit/port-failure-table.mjs <vitest-json-report>
 */
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("用法：node tools/audit/port-failure-table.mjs <vitest-json-report>");
  process.exit(2);
}

const report = JSON.parse(readFileSync(file, "utf8"));
const failing = report.testResults.filter((t) => t.status !== "passed");
const byFile = {};
for (const t of failing) {
  const name = t.name.replace(/.*[\\/]/, "");
  byFile[name] = t.assertionResults.filter((a) => a.status === "failed").length;
}
const rows = Object.entries(byFile).sort((a, b) => b[1] - a[1]);

const lines = [];
lines.push(`失败用例 **${report.numFailedTests}** 个，通过 **${report.numPassedTests}** 个，`);
lines.push(`分布在 **${rows.length}** 个文件（端口模式：测试跑在存储端口上，不再回退旧引擎）。`);
lines.push("");
lines.push("| 测试文件 | 失败数 |");
lines.push("| --- | --- |");
for (const [name, n] of rows) lines.push(`| \`${name}\` | ${n} |`);
console.log(lines.join("\n"));
