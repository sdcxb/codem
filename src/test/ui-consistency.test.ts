/**
 * UI 一致性门禁（回归测试）。
 *
 * 目标（见 docs/UI-DESIGN-SYSTEM.md §4）：把「样式是否统一」变成**只降不升**的数字。
 * 本测试运行审计器并对比基线：任何规则的数量超过基线即失败，并打印头部违规文件，
 * 让「优化 → 审计 → 再优化」的循环不会悄悄回退。
 *
 * 基线更新方式（每次清理一波后）：node tools/ui-audit/scan-ui.mjs --write-baseline
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const SCANNER = join(ROOT, "tools", "ui-audit", "scan-ui.mjs");
const BASELINE = join(ROOT, "tools", "ui-audit", "baseline.json");

interface Report {
  errorCount: number;
  warnCount: number;
  byRule: Record<string, number>;
  byFile: Record<string, number>;
}

function runAudit(): Report {
  const out = execFileSync(process.execPath, [SCANNER, "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out) as Report;
}

function topFiles(report: Report, n = 8): string {
  return Object.entries(report.byFile)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([f, c]) => `  ${String(c).padStart(4)}  ${f}`)
    .join("\n");
}

describe("UI 一致性门禁", () => {
  it("审计器与基线存在", () => {
    expect(existsSync(SCANNER), "缺少 tools/ui-audit/scan-ui.mjs").toBe(true);
    expect(existsSync(BASELINE), "缺少基线，请先运行 scan-ui.mjs --write-baseline").toBe(true);
  });

  it("UI 违规数不超过基线（只降不升）", () => {
    const baseline = JSON.parse(readFileSync(BASELINE, "utf8")) as Report;
    const report = runAudit();

    // 逐规则对比：任何一条规则回退都要能被指出来
    const regressed = Object.entries(baseline.byRule ?? {})
      .filter(([rule, n]) => (report.byRule[rule] ?? 0) > n)
      .map(([rule, n]) => `${rule}: ${n} → ${report.byRule[rule]}`);

    expect(
      regressed,
      `以下规则比基线变多了（禁止回退）：\n  ${regressed.join("\n")}\n\n当前问题最多的文件：\n${topFiles(report)}`,
    ).toEqual([]);

    expect(
      report.errorCount,
      `error 级违规 ${report.errorCount} 超过基线 ${baseline.errorCount}\n\n当前问题最多的文件：\n${topFiles(report)}`,
    ).toBeLessThanOrEqual(baseline.errorCount);

    expect(
      report.warnCount,
      `warn 级违规 ${report.warnCount} 超过基线 ${baseline.warnCount}\n\n当前问题最多的文件：\n${topFiles(report)}`,
    ).toBeLessThanOrEqual(baseline.warnCount);
  }, 120_000);

  it("已清零的硬规则保持为零", () => {
    const report = runAudit();
    // 这两条是最先清零的：字号与圆角必须一直保持 0，否则视为风格回退
    expect(report.byRule["fs-hardcoded"] ?? 0, "出现硬编码字号").toBe(0);
    expect(report.byRule["radius-offscale"] ?? 0, "出现离格圆角").toBe(0);
  }, 120_000);
});
