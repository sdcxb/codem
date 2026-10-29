/**
 * STE-ZH 汇报插件：三态策略、prompt 注入、假验证告警。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

let store: Record<string, unknown> = {};

vi.mock("../core/storage/settings", async () => ({
  ...(await import("./settings-mock")).createSettingsMock(),
  getSettingJSON: (key: string, fallback: unknown) => (key in store ? store[key] : fallback),
  setSettingJSON: (key: string, value: unknown) => {
    store[key] = value;
  },
}));

import {
  STE_ZH_MODE_SETTING,
  getSteZhMode,
  setSteZhMode,
  buildSteZhPromptSection,
  validateSteZhReport,
} from "../core/ste-zh";
import { buildSystemPrompt } from "../core/prompt/prompt";

const agent = { name: "test", prompt: "base", tools: [] } as any;

describe("STE-ZH 汇报插件", () => {
  beforeEach(() => {
    store = {};
  });

  it("STE-1: 默认关闭，不生成规则段", () => {
    expect(getSteZhMode()).toBe("off");
    expect(getSteZhMode() !== "off").toBe(false);
    expect(buildSteZhPromptSection()).toBe("");
  });

  it("STE-2: 智能模式按回合结构选规则", () => {
    setSteZhMode("smart");
    expect(store[STE_ZH_MODE_SETTING]).toBe("smart");
    expect(buildSteZhPromptSection({ userMessage: "改一下按钮颜色" })).toContain("STE-ZH 精简");
    expect(buildSteZhPromptSection({ userMessage: "请向我汇报本次修复的验证结果" })).toContain("STE-ZH，启用中");
    expect(buildSteZhPromptSection({ isSubagent: true })).toContain("子智能体汇报字段");
    expect(buildSteZhPromptSection({ userMessage: "简短汇报一下" })).toContain("STE-ZH 精简");
  });

  it("STE-3: 全量模式始终完整规则，关闭则不注入", () => {
    setSteZhMode("full");
    expect(buildSteZhPromptSection({ userMessage: "改一下按钮颜色" })).toContain("STE-ZH，启用中");
    setSteZhMode("off");
    expect(buildSteZhPromptSection({ userMessage: "请汇报" })).toBe("");
  });

  it("STE-4: 规则段进入 system prompt；关闭后不进入", () => {
    const base = buildSystemPrompt({ agent, steZhSection: "" });
    expect(base).not.toContain("汇报规范（STE-ZH");
    setSteZhMode("full");
    const withRule = buildSystemPrompt({ agent, steZhSection: buildSteZhPromptSection() });
    expect(withRule).toContain("汇报规范（STE-ZH");
    setSteZhMode("off");
    const off = buildSystemPrompt({ agent, steZhSection: buildSteZhPromptSection() });
    expect(off).not.toContain("汇报规范（STE-ZH");
  });

  it("STE-5: 声称已验证但没有测试/构建命令 → 告警；有命令 → 不告警", () => {
    setSteZhMode("smart");
    const noCmd = validateSteZhReport("已完成，已验证。", []);
    expect(noCmd).toHaveLength(1);
    expect(noCmd[0].code).toBe("verified-without-command");

    const withCmd = validateSteZhReport("已完成，已验证。", [
      { tool: "bash", args: { command: "npm test auth" } },
    ]);
    expect(withCmd).toHaveLength(0);

    // 普通工具（读文件）不能证明测试通过
    const readOnly = validateSteZhReport("已完成，已验证。", [
      { tool: "read", args: { path: "a.ts" } },
    ]);
    expect(readOnly).toHaveLength(1);

    // 命令失败也不能证明“已验证”
    const failed = validateSteZhReport("已完成，已验证。", [
      { tool: "bash", args: { command: "npm test" }, status: "error" },
    ]);
    expect(failed).toHaveLength(1);
    const exitOne = validateSteZhReport("已完成，已验证。", [
      { tool: "bash", args: { command: "npm test" }, status: "done", result: "[exit code: 1]" },
    ]);
    expect(exitOne).toHaveLength(1);
    const failedCount = validateSteZhReport("已完成，已验证。", [
      { tool: "bash", args: { command: "npm test" }, status: "done", result: "46 passed, 2 failed" },
    ]);
    expect(failedCount).toHaveLength(1);
    const passed = validateSteZhReport("已完成，已验证。", [
      { tool: "bash", args: { command: "npm test" }, status: "done", result: "48 passed, 0 failed" },
    ]);
    expect(passed).toHaveLength(0);

    const bullets = validateSteZhReport("需要你决定：\n- 撤回（推荐）\n- 保留", []);
    expect(bullets.map((f) => f.code)).toContain("options-not-numbered");
    const numbered = validateSteZhReport("需要你决定：\n1. 撤回（推荐）\n2. 保留", []);
    expect(numbered.map((f) => f.code)).not.toContain("options-not-numbered");
  });
});
