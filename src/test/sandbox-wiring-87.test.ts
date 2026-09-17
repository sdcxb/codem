/**
 * 第 87 波（接线修复）：设置面板里的"🔒 沙箱模式"以前是个装饰品。
 *
 * 事实：`SettingsPanel.tsx` 一直有一个勾选框写 `codem-sandbox-enabled`，文案承诺
 * "AI 只能在当前工作目录及其子目录中写入文件"；而 `AgenticLoop` 传给工具管线的
 * `isSandboxEnabled` 是**硬编码 `() => false`** —— 用户打开开关，`SandboxGuard`
 * 从来没启用过，模型照样写工作区外的文件。
 *
 * 修复后：两处用同一个设置键（`SANDBOX_SETTING_KEY`），开关真的生效；
 * 开关写入失败也会返回 false 让界面提示（不再"看起来打开了"）。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { setSetting, removeSetting, getSetting } from "../core/storage/settings";
import {
  SANDBOX_SETTING_KEY,
  isSandboxAclEnabled,
  setSandboxAclEnabled,
  SandboxGuard,
  createDefaultPolicy,
} from "../core/sandbox/sandbox-acl";
import { initDefaultPipeline, getToolPipeline } from "../core/llm/tool-pipeline";

beforeEach(async () => {
  removeSetting(SANDBOX_SETTING_KEY);
});

afterEach(() => {
  removeSetting(SANDBOX_SETTING_KEY);
});

describe("沙箱开关真的接线（第 87 波）", () => {
  it("SBW-1: 默认关闭；开启后 isSandboxAclEnabled() 为 true，且用的就是面板那个键", () => {
    expect(SANDBOX_SETTING_KEY).toBe("codem-sandbox-enabled");
    expect(isSandboxAclEnabled()).toBe(false);

    expect(setSandboxAclEnabled(true)).toBe(true);
    expect(getSetting(SANDBOX_SETTING_KEY)).toBe("true");
    expect(isSandboxAclEnabled()).toBe(true);

    expect(setSandboxAclEnabled(false)).toBe(true);
    expect(isSandboxAclEnabled()).toBe(false);
  });

  it("SBW-2: 面板源码必须只用统一入口（不能再出现裸的 setSetting/removeSetting 于该键）", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "../components/SettingsPanel.tsx"), "utf8");
    expect(src).toContain("setSandboxAclEnabled");
    expect(src).toContain("isSandboxAclEnabled");
    // 旧的裸写法（会与 AgenticLoop 读的键脱钩、且不触发重渲染）
    expect(src).not.toMatch(/setSetting\(\s*"codem-sandbox-enabled"/);
    expect(src).not.toMatch(/removeSetting\(\s*"codem-sandbox-enabled"/);
  });

  it("SBW-3: AgenticLoop 不再硬编码 false，而是跟随设置", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "../core/llm/agentic-loop.ts"), "utf8");
    expect(src).not.toMatch(/isSandboxEnabled:\s*\(\)\s*=>\s*false/);
    expect(src).toMatch(/isSandboxEnabled:\s*\(\)\s*=>\s*isSandboxAclEnabled\(\)/);
  });

  it("SBW-4（行为）: 开关打开后，工作区外的写入被工具管线拒绝；关闭时放行", async () => {
    const checkPermission = async () => ({ allowed: true });
    const runWrite = async (path: string) => {
      await initDefaultPipeline({
        isPlanMode: () => false,
        isSandboxEnabled: () => isSandboxAclEnabled(),
        isPathWithinWorkspace: (p: string, cwd: string) =>
          p.replace(/\\/g, "/").toLowerCase().startsWith(cwd.replace(/\\/g, "/").toLowerCase()),
        checkPermission,
      });
      const pipeline = getToolPipeline();
      const ctx: any = {
        sessionId: "s1",
        messageId: "m1",
        cwd: "C:/workspace",
        messages: [],
        abort: new AbortController().signal,
        metadata: () => {},
      };
      const handler = async (name: string, args: Record<string, unknown>) => ({
        id: "t1", name, input: args, output: "written", status: "completed" as const,
      });
      return pipeline.execute("write", { path, content: "x" }, ctx, handler);
    };

    const outside = "C:/elsewhere/secret.txt";

    // 关闭（默认）→ 放行
    expect((await runWrite(outside)).result.status).toBe("completed");

    // 打开 → 拦下，并且原因说得清
    setSandboxAclEnabled(true);
    const denied = await runWrite(outside);
    expect(denied.result.status).toBe("error");
    expect(String(denied.result.output)).toMatch(/outside the workspace/i);

    // 工作区内照常放行
    const inside = await runWrite("C:/workspace/src/a.ts");
    expect(inside.result.status).toBe("completed");
  });

  it("SBW-5: 沙箱策略本体仍能拦住受保护路径（回归）", () => {
    // 注意：`sandbox-acl.SandboxGuard`（策略 ACL，构造参数是 policy）与
    // `tool-pipeline.SandboxGuard`（管线守卫，构造参数是 isEnabled 回调）是两个类，
    // 这里测的是策略 ACL 那一侧。
    const guard = new SandboxGuard(createDefaultPolicy("C:/workspace"));
    expect(guard.checkPath("C:/workspace/.env", "write").allowed).toBe(false);
    expect(guard.checkPath("C:/workspace/src/a.ts", "write").allowed).toBe(true);
    expect(createDefaultPolicy("C:/workspace").blockedPaths.length).toBeGreaterThan(0);
  });
});
