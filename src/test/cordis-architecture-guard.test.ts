/**
 * Cordis 插件架构完整性测试 — ARCH-001 ~ ARCH-080
 *
 * 验证 Cordis 插件化改造后的核心架构约束：
 *   A. Provider 不创建独立实例，共享 LLMEngine 的属性 (ARCH-001 ~ ARCH-020)
 *   B. YAML 声明式配置与 builtin-registry 一致性 (ARCH-021 ~ ARCH-035)
 *   C. inject 依赖链正确性 (ARCH-036 ~ ARCH-050)
 *   D. 服务接口契约一致性 (ARCH-051 ~ ARCH-065)
 *   E. mimoAuth 注册链路 (ARCH-066 ~ ARCH-075)
 *   F. LLM Provider 注册无递归 (ARCH-076 ~ ARCH-080)
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const ROOT = join(__dirname, "..", "..");
const SRC = join(ROOT, "src");

function readFile(relPath: string): string {
  return readFileSync(join(SRC, relPath), "utf8");
}

function readYaml(): string {
  return readFileSync(join(ROOT, "config", "codem.base.yml"), "utf8");
}

// ============================================================
// A. Provider 共享 LLMEngine 实例验证
// ============================================================
describe("架构守卫: Provider 共享 LLMEngine 实例", () => {
  const sharedProviders = [
    "agent-registry-provider",
    "permission-provider",
    "memory-provider",
    "retry-provider",
    "mcp-provider",
    "skill-provider",
    "subagent-provider",
    "recovery-provider",
    "cost-tracker-provider",
    "settings-provider",
    "model-profile-provider",
    "tools-provider",
    "tool-render-provider",
    "llm-provider",
    "llm-retry-provider",
  ];

  for (const provider of sharedProviders) {
    it(`ARCH-${String(sharedProviders.indexOf(provider) + 1).padStart(3, "0")}: ${provider} 不创建独立实例（不 new）`, () => {
      const code = readFile(`core/provider/${provider}.ts`);
      // 不应该创建这些类的独立实例
      const forbiddenPatterns = [
        "new AgentRegistry()",
        "new PermissionManager()",
        "new MemoryService()",
        "new RetryExecutor()",
        "new MCPRegistry()",
        "new SkillRegistry()",
        "new SubagentManager()",
        "new SessionRecoveryService()",
        "new CostTracker()",
        "new ModelProfileManager()",
        "new SettingsManager()",
        "new ToolRegistry()",
        "new ToolRenderRegistry()",
        "createDefaultProviders()",
        "createDefaultToolRegistry(",
      ];
      for (const pattern of forbiddenPatterns) {
        expect(code).not.toContain(pattern);
      }
    });
  }

  it("ARCH-016: llm-provider 从 ctx.get('llmEngine') 获取 ProviderRegistry", () => {
    const code = readFile("core/provider/llm-provider.ts");
    expect(code).toContain("ctx.get('llmEngine')");
    expect(code).toContain("engine.providers");
  });

  it("ARCH-017: tools-provider 从 ctx.get('llmEngine') 获取 ToolRegistry", () => {
    const code = readFile("core/provider/tools-provider.ts");
    expect(code).toContain("ctx.get('llmEngine')");
    expect(code).toContain("engine.tools");
  });

  it("ARCH-018: tool-render-provider 从 ctx.get('llmEngine') 获取 ToolRenderRegistry", () => {
    const code = readFile("core/provider/tool-render-provider.ts");
    expect(code).toContain("ctx.get('llmEngine')");
    expect(code).toContain("engine.toolRenderer");
  });

  it("ARCH-019: 所有共享 provider 声明 inject: ['llmEngine']", () => {
    const sharedProviderFiles = sharedProviders.map(p => `core/provider/${p}.ts`);
    for (const file of sharedProviderFiles) {
      const code = readFile(file);
      expect(code).toContain("inject: ['llmEngine']");
    }
  });

  it("ARCH-020: llm-provider 的 complete 方法自动填充 model 字段", () => {
    const code = readFile("core/provider/llm-provider.ts");
    expect(code).toContain("request.model");
    expect(code).toContain("getDefaultModel");
  });
});

// ============================================================
// B. YAML 声明式配置与 builtin-registry 一致性
// ============================================================
describe("架构守卫: YAML 与 builtin-registry 一致性", () => {
  const yamlContent = readYaml().replace(/\r\n/g, "\n");
  const registryCode = readFile("core/plugin-loader/builtin-registry.ts");

  // 检查 YAML 中声明了 inject: [llmEngine] 的插件
  const llmEngineInjectPlugins = [
    "llm", "tools", "memory", "permission", "mcp", "skill",
    "subagent", "settings", "agent-registry", "recovery", "retry",
    "cost-tracker", "model-profile", "tool-render",
  ];

  for (let i = 0; i < llmEngineInjectPlugins.length; i++) {
    const pluginId = llmEngineInjectPlugins[i];
    it(`ARCH-${String(21 + i).padStart(3, "0")}: YAML 中 ${pluginId} 声明 inject: [llmEngine]`, () => {
      // 用 split 解析 YAML 块
      const parts = yamlContent.split(`- id: ${pluginId}\n`);
      expect(parts.length).toBeGreaterThan(1);
      const block = parts[1].split("\n- id:")[0];
      expect(block).toContain("inject: [llmEngine]");
    });

    it(`ARCH-${String(36 + i).padStart(3, "0")}: builtin-registry 中 ${pluginId} 声明 inject: ['llmEngine']`, () => {
      // 检查 builtin-registry 中对应注册行有 inject: ['llmEngine']
      const escapedId = pluginId.replace(/[-]/g, "[-]");
      const regex = new RegExp(`@codem/${escapedId}.*inject:\\s*\\[.*'llmEngine'`);
      expect(regex.test(registryCode)).toBe(true);
    });
  }
});

// ============================================================
// C. Provider 接口契约一致性
// ============================================================
describe("架构守卫: Provider 接口契约一致性", () => {
  it("ARCH-051: llm-provider 暴露 complete 方法", () => {
    const code = readFile("core/provider/llm-provider.ts");
    expect(code).toContain("complete:");
  });

  it("ARCH-052: llm-provider 暴露 stream 方法", () => {
    const code = readFile("core/provider/llm-provider.ts");
    expect(code).toContain("stream:");
  });

  it("ARCH-053: llm-provider 暴露 registerProvider 方法", () => {
    const code = readFile("core/provider/llm-provider.ts");
    expect(code).toContain("registerProvider");
  });

  it("ARCH-054: llm-provider 暴露 listModels 方法", () => {
    const code = readFile("core/provider/llm-provider.ts");
    expect(code).toContain("listModels");
  });

  it("ARCH-055: tools-provider 暴露 register 方法", () => {
    const code = readFile("core/provider/tools-provider.ts");
    expect(code).toContain("register:");
  });

  it("ARCH-056: tools-provider 暴露 execute 方法", () => {
    const code = readFile("core/provider/tools-provider.ts");
    expect(code).toContain("execute:");
  });

  it("ARCH-057: tools-provider 暴露 getDefinitions 方法", () => {
    const code = readFile("core/provider/tools-provider.ts");
    expect(code).toContain("getDefinitions:");
  });

  it("ARCH-058: tools-provider 注册时自动注册 guidance prompt section", () => {
    const code = readFile("core/provider/tools-provider.ts");
    expect(code).toContain("registerToolGuidance");
  });

  it("ARCH-059: retry-provider 暴露 execute 和 classifyError", () => {
    const code = readFile("core/provider/retry-provider.ts");
    expect(code).toContain("execute");
    expect(code).toContain("classifyError");
  });

  it("ARCH-060: subagent-provider 保留 setSpawner 注入逻辑", () => {
    const code = readFile("core/provider/subagent-provider.ts");
    expect(code).toContain("setSpawner");
  });
});

// ============================================================
// D. LLM Provider 注册无递归
// ============================================================
describe("架构守卫: LLM Provider 无递归调用", () => {
  const llmAdapters = [
    "llm-mimo-provider",
    "llm-openai-provider",
    "llm-deepseek-provider",
    "llm-claude-provider",
    "llm-gemini-provider",
    "llm-ollama-provider",
    "llm-pi-ai-provider",
  ];

  for (let i = 0; i < llmAdapters.length; i++) {
    const adapter = llmAdapters[i];
    it(`ARCH-${String(61 + i).padStart(3, "0")}: ${adapter} 不委托给 ctx.get('llm').complete（避免递归）`, () => {
      const code = readFile(`core/provider/${adapter}.ts`);
      // 不应该在 complete 方法中委托给 ctx.get('llm')
      expect(code).not.toMatch(/async\s+complete.*ctx\.get\('llm'\).*complete/);
    });
  }

  it("ARCH-068: llm-deepseek-provider 创建 OpenAICompatibleProvider 实例", () => {
    const code = readFile("core/provider/llm-deepseek-provider.ts");
    expect(code).toContain("OpenAICompatibleProvider");
  });

  it("ARCH-069: llm-pi-ai-provider 创建 OpenAICompatibleProvider 实例", () => {
    const code = readFile("core/provider/llm-pi-ai-provider.ts");
    expect(code).toContain("OpenAICompatibleProvider");
  });
});

// ============================================================
// E. mimoAuth 注册链路
// ============================================================
describe("架构守卫: mimoAuth 注册链路", () => {
  it("ARCH-070: mimo-auth-provider 文件存在并暴露 mimoAuthProvider", () => {
    const code = readFile("core/provider/mimo-auth-provider.ts");
    expect(code).toContain("mimoAuthProvider");
    expect(code).toContain("ctx.provide('mimoAuth'");
    expect(code).toContain("_active: true");
  });

  it("ARCH-071: builtin-registry 注册了 @codem/mimo-auth", () => {
    const code = readFile("core/plugin-loader/builtin-registry.ts");
    expect(code).toContain("@codem/mimo-auth");
    expect(code).toContain("mimoAuthProvider");
  });

  it("ARCH-072: YAML 中有 mimo-auth 条目", () => {
    const yaml = readYaml();
    expect(yaml).toContain("- id: mimo-auth");
    expect(yaml).toContain("@codem/mimo-auth");
  });

  it("ARCH-073: App.tsx 不再直接 ctx.provide('mimoAuth')", () => {
    const code = readFile("App.tsx");
    // 不应该有直接 provide mimoAuth 的代码（注释中的不算）
    const lines = code.split("\n").filter(l => !l.trim().startsWith("//") && !l.trim().startsWith("{/*"));
    const nonCommentCode = lines.join("\n");
    expect(nonCommentCode).not.toMatch(/ctx\.provide\(['"]mimoAuth['"]/);
  });
});

// ============================================================
// F. subagent-claude-code / codex 接口正确性
// ============================================================
describe("架构守卫: 子智能体 LLM 调用接口正确性", () => {
  it("ARCH-076: subagent-claude-code-provider 传 request 对象（非字符串）给 llm.complete", () => {
    const code = readFile("core/provider/subagent-claude-code-provider.ts");
    expect(code).toContain("messages:");
    expect(code).not.toMatch(/llm\.complete\(['"]/);
  });

  it("ARCH-077: subagent-codex-provider 传 request 对象（非字符串）给 llm.complete", () => {
    const code = readFile("core/provider/subagent-codex-provider.ts");
    expect(code).toContain("messages:");
    expect(code).not.toMatch(/llm\.complete\(['"]/);
  });

  it("ARCH-078: session-title-all-prompts-llm-provider 传 request 对象给 llm.complete", () => {
    const code = readFile("core/provider/session-title-all-prompts-llm-provider.ts");
    expect(code).toContain("messages:");
    expect(code).not.toMatch(/llm\.complete\(['"]/);
  });

  it("ARCH-079: session-title-llm-provider 传 request 对象给 llm.complete", () => {
    const code = readFile("core/provider/session-title-llm-provider.ts");
    expect(code).toContain("messages:");
  });

  it("ARCH-080: llm-provider 的 complete 在 provider 不存在时抛出明确错误", () => {
    const code = readFile("core/provider/llm-provider.ts");
    expect(code).toContain("not registered");
  });
});
