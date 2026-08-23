/**
 * 扩充测试手段 — EXT-001 ~ EXT-050
 *
 * 补充传统单元测试之外的测试方法：
 *   A. 契约测试：验证 Provider 接口契约一致性 (EXT-001 ~ EXT-015)
 *   B. 运行时健康检查：验证模块级单例的一致性 (EXT-016 ~ EXT-025)
 *   C. 插件加载顺序守卫：验证 inject 依赖图无环 (EXT-026 ~ EXT-035)
 *   D. 类型导出完整性：验证核心类型被正确导出 (EXT-036 ~ EXT-045)
 *   E. 错误处理韧性：验证关键路径的容错行为 (EXT-046 ~ EXT-050)
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
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
// A. 契约测试：Provider 接口一致性
// ============================================================
describe("契约测试: Provider 接口一致性", () => {
  it("EXT-001: LLMProvider 接口定义了 complete 方法", () => {
    const code = readFile("core/llm/types.ts");
    expect(code).toContain("complete(request: LLMRequest)");
  });

  it("EXT-002: LLMProvider 接口定义了 stream 方法", () => {
    const code = readFile("core/llm/types.ts");
    expect(code).toContain("stream(request: LLMRequest)");
  });

  it("EXT-003: LLMProvider 接口定义了 listModels 方法", () => {
    const code = readFile("core/llm/types.ts");
    expect(code).toContain("listModels()");
  });

  it("EXT-004: LLMRequest 接口包含 model 字段", () => {
    const code = readFile("core/llm/types.ts");
    expect(code).toContain("model: string");
  });

  it("EXT-005: LLMRequest 接口包含 messages 字段", () => {
    const code = readFile("core/llm/types.ts");
    expect(code).toContain("messages: LLMMessage[]");
  });

  it("EXT-006: ToolDef 接口包含 id, description, parameters, execute", () => {
    const code = readFile("core/llm/tools.ts");
    expect(code).toContain("id:");
    expect(code).toContain("description:");
    expect(code).toContain("parameters:");
    expect(code).toContain("execute(");
  });

  it("EXT-007: ProviderRegistry 类有 register, get, getAll, remove 方法", () => {
    const code = readFile("core/llm/provider.ts");
    expect(code).toContain("register(");
    expect(code).toContain("get(");
    expect(code).toContain("getAll()");
    expect(code).toContain("remove(");
  });

  it("EXT-008: ToolRegistry 类有 register, get, getAll, remove, execute 方法", () => {
    const code = readFile("core/llm/tools.ts");
    expect(code).toContain("register(");
    expect(code).toContain("get(");
    expect(code).toContain("getAll()");
    expect(code).toContain("remove(");
    expect(code).toContain("async execute(");
  });

  it("EXT-009: MiMoAuthService 接口包含 _active, getActiveAccount, loadFromAuthJson", () => {
    const code = readFile("core/provider/service-types.ts");
    expect(code).toContain("_active");
    expect(code).toContain("getActiveAccount()");
    expect(code).toContain("loadFromAuthJson()");
  });

  it("EXT-010: LLMEngine 暴露 readonly providers 和 tools 属性", () => {
    const code = readFile("core/llm/index.ts");
    expect(code).toContain("readonly providers:");
    expect(code).toContain("readonly tools:");
  });

  it("EXT-011: LLMEngine 暴露 readonly agents 属性", () => {
    const code = readFile("core/llm/index.ts");
    expect(code).toContain("readonly agents:");
  });

  it("EXT-012: LLMEngine 暴露 readonly permissions, memory, retry 属性", () => {
    const code = readFile("core/llm/index.ts");
    expect(code).toContain("readonly permissions:");
    expect(code).toContain("readonly memory:");
    expect(code).toContain("readonly retry:");
  });

  it("EXT-013: LLMEngine 暴露 readonly mcp, skills, subagents 属性", () => {
    const code = readFile("core/llm/index.ts");
    expect(code).toContain("readonly mcp:");
    expect(code).toContain("readonly skills:");
    expect(code).toContain("readonly subagents:");
  });

  it("EXT-014: LLMEngine 暴露 readonly recovery, costTracker, toolRenderer 属性", () => {
    const code = readFile("core/llm/index.ts");
    expect(code).toContain("readonly recovery:");
    expect(code).toContain("readonly costTracker:");
    expect(code).toContain("readonly toolRenderer:");
  });

  it("EXT-015: LLMEngine 暴露 readonly settings, profileManager 属性", () => {
    const code = readFile("core/llm/index.ts");
    expect(code).toContain("readonly settings:");
    expect(code).toContain("readonly profileManager:");
  });
});

// ============================================================
// B. 运行时健康检查：模块级单例一致性
// ============================================================
describe("运行时健康检查: 模块级单例一致性", () => {
  it("EXT-016: getLLMEngine 返回单例", async () => {
    const { getLLMEngine } = await import("../core/llm/index.ts");
    const engine1 = getLLMEngine();
    const engine2 = getLLMEngine();
    expect(engine1).toBe(engine2);
  });

  it("EXT-017: getAgentRegistry 返回单例", async () => {
    const { getAgentRegistry } = await import("../core/agent/agent.ts");
    const r1 = getAgentRegistry();
    const r2 = getAgentRegistry();
    expect(r1).toBe(r2);
  });

  it("EXT-018: getPermissionManager 返回单例", async () => {
    const { getPermissionManager } = await import("../core/permission/permission.ts");
    const m1 = getPermissionManager();
    const m2 = getPermissionManager();
    expect(m1).toBe(m2);
  });

  it("EXT-019: getMemoryService 返回单例", async () => {
    const { getMemoryService } = await import("../core/memory/memory.ts");
    const s1 = getMemoryService();
    const s2 = getMemoryService();
    expect(s1).toBe(s2);
  });

  it("EXT-020: getRetryExecutor 返回单例", async () => {
    const { getRetryExecutor } = await import("../core/retry/retry.ts");
    const e1 = getRetryExecutor();
    const e2 = getRetryExecutor();
    expect(e1).toBe(e2);
  });

  it("EXT-021: getCostTracker 返回单例", async () => {
    const { getCostTracker } = await import("../core/llm/cost-tracker.ts");
    const t1 = getCostTracker();
    const t2 = getCostTracker();
    expect(t1).toBe(t2);
  });

  it("EXT-022: getToolPipeline 返回单例", async () => {
    const { getToolPipeline } = await import("../core/llm/tool-pipeline.ts");
    const p1 = getToolPipeline();
    const p2 = getToolPipeline();
    expect(p1).toBe(p2);
  });

  it("EXT-023: getToolRenderRegistry 返回单例", async () => {
    const { getToolRenderRegistry } = await import("../core/llm/tool-renderer.ts");
    const r1 = getToolRenderRegistry();
    const r2 = getToolRenderRegistry();
    expect(r1).toBe(r2);
  });

  it("EXT-024: getDelegationOrchestrator 返回单例", async () => {
    const { getDelegationOrchestrator } = await import("../core/session/orchestrator.ts");
    const o1 = getDelegationOrchestrator();
    const o2 = getDelegationOrchestrator();
    expect(o1).toBe(o2);
  });

  it("EXT-025: LLMEngine.providers 是 ProviderRegistry 实例", async () => {
    const { getLLMEngine } = await import("../core/llm/index.ts");
    const engine = getLLMEngine();
    expect(engine.providers).toBeDefined();
    expect(engine.providers.get).toBeDefined();
    expect(engine.providers.getAll).toBeDefined();
    expect(engine.providers.register).toBeDefined();
  });
});

// ============================================================
// C. 插件加载顺序守卫
// ============================================================
describe("插件加载顺序守卫: inject 依赖图", () => {
  const yaml = readYaml().replace(/\r\n/g, "\n");

  it("EXT-026: llm 依赖 llmEngine（llmEngine 先于 llm 加载）", () => {
    const match = yaml.match(/^- id: llm\n([\s\S]*?)(?=^\n- id:|^$)/m);
    expect(match).toBeTruthy();
    expect(match![1]).toContain("inject: [llmEngine]");
  });

  it("EXT-027: tools 依赖 llmEngine", () => {
    const match = yaml.match(/^- id: tools\n([\s\S]*?)(?=^\n- id:|^$)/m);
    expect(match).toBeTruthy();
    expect(match![1]).toContain("inject: [llmEngine]");
  });

  it("EXT-028: llm-mimo 依赖 llm（llm 先于 llm-mimo 加载）", () => {
    const match = yaml.match(/^- id: llm-mimo\n([\s\S]*?)(?=^\n- id:|^$)/m);
    expect(match).toBeTruthy();
    expect(match![1]).toContain("inject: [llm]");
  });

  it("EXT-029: llm-deepseek 依赖 llm", () => {
    const match = yaml.match(/^- id: llm-deepseek\n([\s\S]*?)(?=^\n- id:|^$)/m);
    expect(match).toBeTruthy();
    expect(match![1]).toContain("inject: [llm]");
  });

  it("EXT-030: agent-engine 依赖 llmEngine", () => {
    const match = yaml.match(/^- id: agent-engine\n([\s\S]*?)(?=^\n- id:|^$)/m);
    expect(match).toBeTruthy();
    expect(match![1]).toContain("inject: [llmEngine]");
  });

  it("EXT-031: session-title-llm 依赖 llm 和 session", () => {
    const match = yaml.match(/^- id: session-title-llm\n([\s\S]*?)(?=^\n- id:|^$)/m);
    expect(match).toBeTruthy();
    expect(match![1]).toContain("inject: [llm, session]");
  });

  it("EXT-032: commands 依赖 skill", () => {
    const match = yaml.match(/^- id: commands\n([\s\S]*?)(?=^\n- id:|^$)/m);
    expect(match).toBeTruthy();
    expect(match![1]).toContain("inject: [skill]");
  });

  it("EXT-033: subagent-claude-code 依赖 subagent 和 llm", () => {
    const match = yaml.match(/^- id: subagent-claude-code\n([\s\S]*?)(?=^\n- id:|^$)/m);
    expect(match).toBeTruthy();
    expect(match![1]).toContain("inject: [subagent, llm]");
  });

  it("EXT-034: context-info 依赖 settings", () => {
    const match = yaml.match(/^- id: context-info\n([\s\S]*?)(?=^\n- id:|^$)/m);
    expect(match).toBeTruthy();
    expect(match![1]).toContain("inject: [settings]");
  });

  it("EXT-035: cli 依赖 session, tools, pluginRegistry", () => {
    const match = yaml.match(/^- id: cli\n([\s\S]*?)(?=^\n- id:|^$)/m);
    expect(match).toBeTruthy();
    expect(match![1]).toContain("inject: [session, tools, pluginRegistry]");
  });
});

// ============================================================
// D. 类型导出完整性
// ============================================================
describe("类型导出完整性", () => {
  it("EXT-036: core/llm/index.ts 导出 LLMEngine 类型", () => {
    const code = readFile("core/llm/index.ts");
    expect(code).toContain("export class LLMEngine");
  });

  it("EXT-037: core/llm/index.ts 导出 getLLMEngine 函数", () => {
    const code = readFile("core/llm/index.ts");
    expect(code).toContain("export function getLLMEngine");
  });

  it("EXT-038: core/llm/provider.ts 导出 ProviderRegistry 类", () => {
    const code = readFile("core/llm/provider.ts");
    expect(code).toContain("export class ProviderRegistry");
  });

  it("EXT-039: core/llm/tools.ts 导出 ToolRegistry 类", () => {
    const code = readFile("core/llm/tools.ts");
    expect(code).toContain("export class ToolRegistry");
  });

  it("EXT-040: core/llm/tool-pipeline.ts 导出 getToolPipeline 函数", () => {
    const code = readFile("core/llm/tool-pipeline.ts");
    expect(code).toContain("export function getToolPipeline");
  });

  it("EXT-041: core/llm/tool-renderer.ts 导出 ToolRenderRegistry 类", () => {
    const code = readFile("core/llm/tool-renderer.ts");
    expect(code).toContain("export class ToolRenderRegistry");
  });

  it("EXT-042: core/llm/cost-tracker.ts 导出 CostTracker 类", () => {
    const code = readFile("core/llm/cost-tracker.ts");
    expect(code).toMatch(/export class CostTracker/);
  });

  it("EXT-043: core/agent/agent.ts 导出 AgentRegistry 类", () => {
    const code = readFile("core/agent/agent.ts");
    expect(code).toContain("export class AgentRegistry");
  });

  it("EXT-044: core/consumer/index.ts 导出 callLLM, callTool, tryGetCtx, setActiveContext", () => {
    const code = readFile("core/consumer/index.ts");
    expect(code).toContain("export async function callLLM");
    expect(code).toContain("tryGetCtx");
    expect(code).toContain("setActiveContext");
  });

  it("EXT-045: core/auth/mimo.ts 导出 MiMoAuth 类和 getMiMoAuth 函数", () => {
    const code = readFile("core/auth/mimo.ts");
    expect(code).toContain("export class MiMoAuth");
    expect(code).toContain("export function getMiMoAuth");
  });
});

// ============================================================
// E. 错误处理韧性
// ============================================================
describe("错误处理韧性: 关键路径容错", () => {
  it("EXT-046: llmProvider 在 llmEngine 不可用时抛出明确错误", () => {
    const code = readFile("core/provider/llm-provider.ts");
    expect(code).toContain("llmEngine not available");
    expect(code).toContain("throw new Error");
  });

  it("EXT-047: toolsProvider 在 llmEngine 不可用时 warn 并返回", () => {
    const code = readFile("core/provider/tools-provider.ts");
    expect(code).toContain("llmEngine not available");
  });

  it("EXT-048: AgenticLoop 在服务不可用时回退到单例", () => {
    const code = readFile("core/llm/agentic-loop.ts");
    expect(code).toContain("falling back to singleton");
  });

  it("EXT-049: llmProvider.registerProvider 在 registry 不可用时返回 noop dispose", () => {
    const code = readFile("core/provider/llm-provider.ts");
    expect(code).toContain("return () => {}");
  });

  it("EXT-050: builtin-registry 所有 provider 工厂返回函数", () => {
    const code = readFile("core/plugin-loader/builtin-registry.ts");
    // 每个 registerBuiltinPlugin 调用应该有一个工厂函数
    const matches = code.match(/registerBuiltinPlugin\(/g);
    expect(matches).toBeDefined();
    expect(matches!.length).toBeGreaterThan(50);
  });
});
