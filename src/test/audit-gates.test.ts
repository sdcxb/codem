/**
 * 审计门禁（第 88 波）：把两个"一次性扫描脚本"变成**每次跑测试都会执行**的门禁。
 *
 * 背景：第 86/87 波用一次性脚本扫出并修掉了 A 类（静默空写）与 B 类（假成功）缺陷，
 * 但一次性脚本的结论会随时间失效 —— 新写的代码可以再次引入同样的模式。
 * 现在：
 *   · `tools/audit/scan-false-success.mjs`（P1：catch 里 return true；P2：写/动作类函数里
 *     catch 只有日志）；
 *   · `tools/audit/scan-silent-write.mjs`（A 类：`db.run(UPDATE … WHERE id = ?)` 未走 runGuarded）；
 * 都由本文件在 `npx vitest run` 中强制执行，未豁免的命中直接让测试变红。
 *
 * 另外本文件**自检扫描器有效**（用临时样本证明它真的能报出来），避免"门禁永远绿"
 * 这种更隐蔽的失效。
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.join(__dirname, "..", "..");
const TOOLS = path.join(ROOT, "tools", "audit");

async function loadScanners() {
  // 用动态 import 直接调函数（避免子进程 + 管道，在受限环境下更稳）
  const fsScanner = await import(path.join(TOOLS, "scan-false-success.mjs") as any);
  const swScanner = await import(path.join(TOOLS, "scan-silent-write.mjs") as any);
  const gbScanner = await import(path.join(TOOLS, "scan-guard-bypass.mjs") as any);
  return { fsScanner, swScanner, gbScanner };
}

describe("审计门禁 —— 仓库当前必须零未豁免命中", () => {
  it("GATE-1: B 类（假成功）扫描无未豁免命中", async () => {
    const { fsScanner } = await loadScanners();
    const result = fsScanner.scanFalseSuccess({});
    const detail = result.violations
      .map((v: any) => `${v.file}:${v.line} [${v.kind}] ${v.fn} → ${v.preview}`)
      .join("\n");
    expect(result.scannedFiles).toBeGreaterThan(100);
    expect(result.violations, `未豁免的假成功命中：\n${detail}`).toEqual([]);
  });

  it("GATE-2: A 类（静默空写）扫描无未豁免命中", async () => {
    const { swScanner } = await loadScanners();
    const result = swScanner.scanSilentWrites({});
    const detail = result.violations.map((v: any) => `${v.file}:${v.line} ${v.code}`).join("\n");
    expect(result.violations, `未接 runGuarded 的空写：\n${detail}`).toEqual([]);
  });

  it("GATE-3: 豁免清单里每条都必须写明理由（不允许无理由豁免）", () => {
    const allow = JSON.parse(fs.readFileSync(path.join(TOOLS, "allowlist.json"), "utf8"));
    for (const key of ["falseSuccess", "silentWrites", "guardBypass"]) {
      for (const entry of allow[key] ?? []) {
        expect(typeof entry.file, `${key} 条目缺少 file`).toBe("string");
        expect((entry.reason ?? "").length, `${key} 的 ${entry.file} 缺少理由`).toBeGreaterThan(8);
      }
    }
  });

  it("GATE-5: C 类（守卫被绕过）扫描无未豁免命中", async () => {
    const { gbScanner } = await loadScanners();
    const result = gbScanner.scanGuardBypass({});
    const detail = result.violations
      .map((v: any) => `${v.file}:${v.line} [${v.kind}] ${v.fn} → ${v.preview}\n    ${v.why}`)
      .join("\n");
    expect(result.scannedFiles).toBeGreaterThan(100);
    expect(result.violations, `未豁免的守卫绕过命中：\n${detail}`).toEqual([]);
  });
});

describe("扫描器自检（门禁本身必须会咬）", () => {
  it("GATE-4: 故意写坏的样本必须被三个扫描器报出来", async () => {
    const { fsScanner, swScanner, gbScanner } = await loadScanners();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codem-audit-gate-"));
    const probe = path.join(tmp, "probe.ts");
    fs.writeFileSync(
      probe,
      [
        "export function saveWidget(id: string) {",
        "  try {",
        "    db.run(`UPDATE widgets SET name = ? WHERE id = ?`, ['x', id]);",
        "  } catch (e) {",
        "    console.warn('saveWidget failed:', e);",
        "  }",
        "}",
        "export function createWidget(): boolean {",
        "  try {",
        "    return true;",
        "  } catch (e) {",
        "    return true;", // ← 典型假成功
        "  }",
        "}",
        "export function checkPermission(tool: string) {",
        "  try {",
        "    return analyzeBashCommand(tool).classification;",
        "  } catch {",
        "    return { action: 'allow' };", // ← 守卫失败 → 默认放行
        "  }",
        "}",
      ].join("\n"),
      "utf8",
    );

    try {
      const fsResult = fsScanner.scanFalseSuccess({ root: tmp, allowlist: { falseSuccess: [], silentWrites: [], guardBypass: [] } });
      const swResult = swScanner.scanSilentWrites({ root: tmp, allowlist: { falseSuccess: [], silentWrites: [], guardBypass: [] } });
      const gbResult = gbScanner.scanGuardBypass({ root: tmp, allowlist: { falseSuccess: [], silentWrites: [], guardBypass: [] } });

      // P1：catch 里 return true
      expect(fsResult.p1.length, "应报出 catch 里 return true").toBeGreaterThan(0);
      // P2：写/动作类函数的 catch 只有日志
      expect(fsResult.p2.length, "应报出只有日志的 catch").toBeGreaterThan(0);
      // A 类：未走 runGuarded 的 UPDATE
      expect(swResult.updates.length, "应报出未接 runGuarded 的 UPDATE").toBeGreaterThan(0);
      expect(swResult.violations.length).toBeGreaterThan(0);
      // C 类：守卫失败 → 默认放行
      expect(gbResult.findings.length, "应报出守卫失败时的 fail-open 返回").toBeGreaterThan(0);
      expect(gbResult.violations.length).toBeGreaterThan(0);
      expect(fsScanner.stripComments("// db.run(`UPDATE x SET y = ? WHERE id = ?`)\nconst a = 1;")).not.toMatch(/UPDATE/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
