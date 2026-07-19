/**
 * SkillToolProvider — 抽象接口，让技能可以动态注册工具。
 *
 * 当一个技能的 SKILL.md 声明了 `provider` 和 `tools` 字段时，
 * 系统会通过此接口加载该技能的工具实现。
 *
 * 安全限制：
 * - 仅内置技能（builtin）和用户明确确认安装的技能（user/external）可加载 Provider。
 * - Provider 代码在主进程中执行，需注意安全性。
 */

import type { ToolDef, ToolContext, ToolExecuteResult } from "../llm/tools";
import type { SkillDefinition, SkillToolDeclaration } from "./skill";
import { PromptOptimizationProvider } from "./providers/prompt-optimization-provider";
import { InteractiveFormProvider } from "./providers/interactive-form-provider";

// ========== Skill Tool Provider Interface ==========

/**
 * Provider 的上下文，在创建时传入。
 * 提供技能所需的运行时信息和回调。
 */
export interface SkillProviderContext {
  /** 技能定义 */
  skill: SkillDefinition;
  /** 技能所在目录的绝对路径（用于读取参考文件等） */
  skillDir: string;
  /** 传入的静态配置 */
  config?: Record<string, unknown>;
}

/**
 * SkillToolProvider 接口。
 * 每个携带工具的技能需要实现此接口。
 */
export interface SkillToolProvider {
  /** Provider 名称（通常与技能名一致） */
  readonly name: string;

  /**
   * 初始化 Provider。
   * 在技能首次加载时调用，可以在此连接 MCP、加载资源等。
   */
  initialize?(ctx: SkillProviderContext): Promise<void>;

  /**
   * 获取此 Provider 提供的所有工具定义。
   * 返回的 ToolDef 会被注册到 ToolRegistry 中。
   */
  getTools(): ToolDef[];

  /**
   * 清理资源。
   * 在技能卸载时调用。
   */
  dispose?(): Promise<void>;
}

// ========== Provider Factory ==========

/**
 * Provider 工厂函数类型。
 * 接收上下文，返回一个 SkillToolProvider 实例。
 */
export type SkillProviderFactory = (ctx: SkillProviderContext) => SkillToolProvider;

// ========== Built-in Provider Registry ==========

/**
 * 内置 Provider 注册表。
 * 内置技能的 Provider 直接在这里注册，无需动态加载。
 */
const builtinProviderFactories = new Map<string, SkillProviderFactory>();

/**
 * 注册一个内置 Provider 工厂。
 * @param skillName 技能名称
 * @param factory Provider 工厂函数
 */
export function registerBuiltinProvider(skillName: string, factory: SkillProviderFactory): void {
  builtinProviderFactories.set(skillName, factory);
}

/**
 * 获取内置 Provider 工厂。
 */
export function getBuiltinProviderFactory(skillName: string): SkillProviderFactory | undefined {
  return builtinProviderFactories.get(skillName);
}

// ========== Register Built-in Providers ==========

// D2: prompt-optimization
registerBuiltinProvider("prompt-optimization", (ctx: SkillProviderContext) => {
  const provider = new PromptOptimizationProvider();
  if (provider.initialize) {
    provider.initialize(ctx).catch(() => {});
  }
  return provider;
});

// D3: interactive
registerBuiltinProvider("interactive", (ctx: SkillProviderContext) => {
  const provider = new InteractiveFormProvider();
  if (provider.initialize) {
    provider.initialize(ctx).catch(() => {});
  }
  return provider;
});

// ========== Helper: Create ToolDef from Declaration ==========

/**
 * 根据技能工具声明和执行函数创建 ToolDef。
 * 这是一个便捷方法，让 Provider 不需要手写完整的 ToolDef。
 */
export function createSkillTool(
  declaration: SkillToolDeclaration,
  executeFn: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolExecuteResult>,
): ToolDef {
  return {
    id: declaration.name,
    description: declaration.description,
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: true,
    },
    execute: executeFn,
  };
}
