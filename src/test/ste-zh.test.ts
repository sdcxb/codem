/**
 * STE-ZH 汇报插件：设置开关与主 prompt 注入。
 *
 * 只测两条用户可见语义：
 * 1. 默认关闭，开启后才生成规则段；
 * 2. 规则段确实进入 system prompt，关闭时不进入。
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
  STE_ZH_SETTING,
  isSteZhEnabled,
  setSteZhEnabled,
  buildSteZhPromptSection,
} from "../core/ste-zh";
import { buildSystemPrompt } from "../core/prompt/prompt";

const agent = { name: "test", prompt: "base", tools: [] } as any;

describe("STE-ZH 汇报插件", () => {
  beforeEach(() => {
    store = {};
  });

  it("STE-1: 默认关闭，不生成规则段", () => {
    expect(isSteZhEnabled()).toBe(false);
    expect(buildSteZhPromptSection()).toBe("");
  });

  it("STE-2: 开启后生成固定规则，包含状态/验证/证据/子智能体字段", () => {
    setSteZhEnabled(true);
    expect(store[STE_ZH_SETTING]).toBe(true);
    const section = buildSteZhPromptSection();
    expect(section).toContain("已完成");
    expect(section).toContain("未验证");
    expect(section).toContain("路径:行号");
    expect(section).toContain("status");
    expect(section).toContain("evidence");
  });

  it("STE-3: 规则段进入 system prompt；关闭后不进入", () => {
    const base = buildSystemPrompt({ agent, steZhSection: "" });
    expect(base).not.toContain("汇报规范（STE-ZH");
    setSteZhEnabled(true);
    const withRule = buildSystemPrompt({ agent, steZhSection: buildSteZhPromptSection() });
    expect(withRule).toContain("汇报规范（STE-ZH");
    setSteZhEnabled(false);
    const off = buildSystemPrompt({ agent, steZhSection: buildSteZhPromptSection() });
    expect(off).not.toContain("汇报规范（STE-ZH");
  });
});
