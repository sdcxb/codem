/**
 * 打印 vitest JSON 报告里的失败明细（文件 → 用例 → 首行断言信息）。
 * 用法：node tools/audit/show-failures.mjs <vitest-json-report>
 */
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("用法：node tools/audit/show-failures.mjs <vitest-json-report>");
  process.exit(2);
}

const report = JSON.parse(readFileSync(file, "utf8"));
const failing = report.testResults.filter((t) => t.status !== "passed");
console.log(`失败用例 ${report.numFailedTests} 个 / 通过 ${report.numPassedTests} 个`);
for (const t of failing) {
  console.log(`\n文件: ${t.name.replace(/.*[\\/]/, "")}`);
  for (const a of t.assertionResults.filter((x) => x.status === "failed")) {
    const first = (a.failureMessages?.[0] ?? "")
      .split("\n")
      .filter((l) => l.trim())
      .slice(0, 3)
      .join(" | ");
    console.log(` - ${a.fullName}`);
    console.log(`   ${first.slice(0, 260)}`);
  }
}
