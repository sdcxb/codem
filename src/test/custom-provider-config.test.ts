import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

// 通用协议配置（Custom OpenAI-compatible Provider）回归测试
// 覆盖：设置 UI 添加入口、引擎注册能力、模型→provider 路由、模型列表生成

const root = path.resolve(__dirname, "..");

function readSource(rel: string): string {
  return fs.readFileSync(path.join(root, rel), "utf-8");
}

describe("custom-provider (通用协议配置)", () => {
  it("CP-001: SettingsPanel 提供『添加自定义 Provider』入口与表单", () => {
    const src = readSource("components/SettingsPanel.tsx");
    expect(src).toContain("添加自定义 Provider");
    expect(src).toContain("custom-");
    expect(src).toContain("addCustomProvider");
    expect(src).toContain("removeCustomProvider");
  });

  it("CP-002: ProviderKey 支持 custom 标记，且保存/删除会触发引擎重配", () => {
    const src = readSource("components/SettingsPanel.tsx");
    expect(src).toContain("custom?: boolean");
    expect(src).toContain("codem-settings-changed");
    expect(src).toContain("codem-dynamic-models");
  });

  it("CP-003: LLMEngine 提供 registerCustomProvider 动态注册 OpenAI 兼容 Provider", () => {
    const src = readSource("core/llm/index.ts");
    expect(src).toContain("registerCustomProvider");
    expect(src).toContain("OpenAICompatibleProvider");
    expect(src).toContain("this.providers.register(provider)");
    expect(src).toContain("baseUrl: config.baseUrl || \"https://api.openai.com/v1\"");
  });

  it("CP-004: model-config 提供 resolveProviderForModel 支持自定义 provider 路由", () => {
    const src = readSource("core/model-config.ts");
    expect(src).toContain("resolveProviderForModel");
    // 前缀匹配内置，动态模型归属匹配自定义
    expect(src).toContain("model.startsWith(\"deepseek\")");
    expect(src).toContain("dyn.some((m) => m.id === model)");
  });

  it("CP-005: App.tsx 在 configureEngine 中对 custom provider 调用 registerCustomProvider", () => {
    const src = readSource("App.tsx");
    expect(src).toContain("p.custom");
    expect(src).toContain("engine.registerCustomProvider");
    expect(src).toContain("resolveProviderForModel(model)");
  });

  it("CP-006: 模型列表生成支持任意 provider id（动态模型优先）", () => {
    const src = readSource("core/model-config.ts");
    expect(src).toContain("getConfiguredApiModels");
    expect(src).toContain("dynamicModels[p.id]");
    expect(src).toContain("if (!p.apiKey || p.id === \"mimo\") continue;");
  });

  it("CP-007: getFirstConfiguredModel 支持自定义 provider（动态模型优先）", () => {
    const src = readSource("core/model-config.ts");
    expect(src).toContain("getFirstConfiguredModel");
    // 自定义 provider 从 codem-dynamic-models 取第一个动态模型
    expect(src).toContain("dyn[0].id");
    expect(src).toContain("dynamicModels[p.id]");
    // 兜底仍回退 mimo（无任何已配置 provider 时）
    expect(src).toContain('"mimo-v2.5-pro"');
  });

  it("CP-008: App.tsx 初始模型推断不再硬编码 fallback 到 mimo", () => {
    const src = readSource("App.tsx");
    // 三处推断（_initialModel / dbReady / configureEngine）都改用 getFirstConfiguredModel
    const count = src.split("getFirstConfiguredModel()").length - 1;
    expect(count).toBeGreaterThanOrEqual(3);
    // 旧逻辑已删除：不再在无 savedModel 时遍历 defaultModels 静态表
    expect(src).not.toContain('if (p.apiKey && p.id !== "mimo" && defaultModels[p.id])');
    expect(src).not.toContain('finalModel = models[p.id] || model;');
  });

  it("CP-009: runAgenticLoop 重载 key 时对 custom provider 幂等注册", () => {
    const src = readSource("App.tsx");
    expect(src).toContain('if (p.custom) {');
    expect(src).toContain("engine.registerCustomProvider(p.id");
  });
});
