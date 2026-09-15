/**
 * 计划模式只读契约 + 审批缺省的 fail-closed（第 83 波审计修正）
 *
 * 两个"守卫被绕过"的真实缺陷：
 *   ① **计划模式（Plan mode）的写工具名单里没有 shell** —— 于是计划模式下
 *      `Set-Content -Path src/x.ts -Value '…'`、`Remove-Item …` 照样执行，
 *      "计划模式只读"这个对用户的承诺被绕过；
 *   ② **权限层 `ask` 但没有审批回调时默认放行** —— `if (action === "ask" && onPermissionRequest)`
 *      与 `else if (action === "deny")` 都不命中就落到 `return { allowed: true }`，
 *      于是"ask"模式在没接回调的调用方那里**等于 full**。
 */

import { describe, it, expect } from "vitest";
import { PlanModeGuard } from "../core/llm/tool-pipeline";

const ctx = {} as any;

describe("计划模式只读契约（含 shell）", () => {
  const guard = new PlanModeGuard(() => true);
  const guardOff = new PlanModeGuard(() => false);

  it("PLAN-1: 非计划模式下一切放行", async () => {
    expect((await guardOff.execute("bash", { command: "Remove-Item -Recurse -Force D:\\x" }, ctx)).action).toBe("proceed");
    expect((await guardOff.execute("write", { path: "a.ts" }, ctx)).action).toBe("proceed");
  });

  it("PLAN-2: 计划模式下写文件类工具照旧被拒", async () => {
    for (const t of ["write", "edit", "multi_edit", "delete_file", "delete"]) {
      const r = await guard.execute(t, {}, ctx);
      expect(r.action, t).toBe("deny");
    }
  });

  it("PLAN-3（修复点）: 计划模式下**会写盘的 shell 命令**必须被拒", async () => {
    for (const cmd of [
      'Set-Content -Path src/x.ts -Value "x"',
      "Remove-Item -Recurse -Force D:\\proj\\out",
      "mkdir newdir",
      "echo hi > out.txt",
      'python -c "open(\'x\',\'w\')"',
    ]) {
      const r = await guard.execute("bash", { command: cmd }, ctx);
      expect(r.action, `计划模式不该放过：${cmd}`).toBe("deny");
      expect(String((r as any).denyMessage)).toMatch(/read-only|Plan mode/i);
    }
  });

  it("PLAN-4: 计划模式下**只读查询**不该被误拦（否则计划模式没法调研）", async () => {
    for (const cmd of [
      "Get-ChildItem -Path src",
      "Get-Content README.md",
      "git status",
      "ls -la",
      "grep -n foo bar.ts",
    ]) {
      const r = await guard.execute("bash", { command: cmd }, ctx);
      expect(r.action, `只读命令应放行：${cmd}`).toBe("proceed");
    }
  });
});

describe("审批缺省必须 fail-closed（源码契约）", () => {
  it("PLAN-5: agentic-loop 里 action==='ask' 且无回调时必须拒绝", () => {
    const fs = require("fs");
    const path = require("path");
    const loop = fs.readFileSync(path.join(__dirname, "../core/llm/agentic-loop.ts"), "utf-8");
    const idx = loop.indexOf('if (action === "ask" && this.config.onPermissionRequest)');
    expect(idx).toBeGreaterThan(-1);
    const block = loop.slice(idx, idx + 1800);
    expect(block, "ask 没有审批通道时要拒绝").toMatch(/else if \(action === "ask"\)[\s\S]{0,1400}allowed: false/);
    expect(block).toMatch(/no approval channel/);
  });
});
