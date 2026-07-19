/**
 * SkillToolRegistry — 管理技能 Provider 的注册/注销。
 *
 * 当 load_skill 工具加载一个技能时：
 * 1. 检查该技能是否声明了 provider
 * 2. 如果有，通过此注册表创建 Provider 实例
 * 3. Provider 实例提供的工具被注册到 ToolRegistry
 * 4. 技能卸载时，Provider 被清理，工具从 ToolRegistry 移除
 */

import type { ToolRegistry } from "../llm/tools";
import type { SkillDefinition } from "./skill";
import {
  type SkillToolProvider,
  type SkillProviderContext,
  type SkillProviderFactory,
  getBuiltinProviderFactory,
} from "./provider";

export class SkillToolRegistry {
  /** 已加载的 Provider 实例，按技能名索引 */
  private providers: Map<string, SkillToolProvider> = new Map();

  /** Provider 创建时注册到 ToolRegistry 的工具名，用于卸载时清理 */
  private registeredToolNames: Map<string, string[]> = new Map();

  /** 外部注册的 Provider 工厂（非内置） */
  private externalFactories: Map<string, SkillProviderFactory> = new Map();

  /**
   * 注册外部 Provider 工厂。
   * 用于从 ZIP 安装的技能。
   */
  registerFactory(skillName: string, factory: SkillProviderFactory): void {
    this.externalFactories.set(skillName, factory);
  }

  /**
   * 加载技能的 Provider 并注册工具。
   *
   * @param skill 技能定义
   * @param skillDir 技能目录
   * @param toolRegistry 工具注册表
   * @returns 加载的工具名列表，如果技能没有 Provider 则返回空数组
   */
  async loadProvider(
    skill: SkillDefinition,
    skillDir: string,
    toolRegistry: ToolRegistry,
  ): Promise<string[]> {
    // 如果已加载，先卸载
    if (this.providers.has(skill.name)) {
      await this.unloadProvider(skill.name, toolRegistry);
    }

    // 检查是否有 Provider 声明
    if (!skill.provider && !skill.tools?.length) {
      return [];
    }

    // 查找工厂函数：先查内置，再查外部注册
    let factory = getBuiltinProviderFactory(skill.name);
    if (!factory) {
      factory = this.externalFactories.get(skill.name);
    }

    // 如果没有工厂但声明了 tools，创建空 Provider
    // （工具声明仅用于信息展示，实际工具通过其他方式注册）
    if (!factory) {
      if (skill.tools?.length) {
        // 仅记录工具名，不实际注册
        const toolNames = skill.tools.map((t) => t.name);
        this.registeredToolNames.set(skill.name, toolNames);
        return toolNames;
      }
      return [];
    }

    // 创建 Provider 实例
    const ctx: SkillProviderContext = {
      skill,
      skillDir,
      config: skill.provider?.config || skill.config,
    };

    const provider = factory(ctx);

    // 初始化
    if (provider.initialize) {
      await provider.initialize(ctx);
    }

    // 获取并注册工具
    const tools = provider.getTools();
    const toolNames: string[] = [];
    for (const tool of tools) {
      toolRegistry.register(tool);
      toolNames.push(tool.id);
    }

    // 保存状态
    this.providers.set(skill.name, provider);
    this.registeredToolNames.set(skill.name, toolNames);

    return toolNames;
  }

  /**
   * 卸载技能的 Provider 并清理工具。
   */
  async unloadProvider(skillName: string, toolRegistry: ToolRegistry): Promise<void> {
    const provider = this.providers.get(skillName);
    if (provider) {
      if (provider.dispose) {
        await provider.dispose();
      }
      this.providers.delete(skillName);
    }

    // 清理注册的工具
    const toolNames = this.registeredToolNames.get(skillName);
    if (toolNames) {
      for (const toolName of toolNames) {
        toolRegistry.remove(toolName);
      }
      this.registeredToolNames.delete(skillName);
    }
  }

  /**
   * 检查技能是否已加载 Provider。
   */
  isLoaded(skillName: string): boolean {
    return this.providers.has(skillName) || this.registeredToolNames.has(skillName);
  }

  /**
   * 获取已加载技能的工具名列表。
   */
  getLoadedTools(skillName: string): string[] {
    return this.registeredToolNames.get(skillName) || [];
  }

  /**
   * 获取所有已加载的技能名。
   */
  getLoadedSkillNames(): string[] {
    return Array.from(this.registeredToolNames.keys());
  }

  /**
   * 卸载所有 Provider。
   */
  async unloadAll(toolRegistry: ToolRegistry): Promise<void> {
    const names = Array.from(this.registeredToolNames.keys());
    for (const name of names) {
      await this.unloadProvider(name, toolRegistry);
    }
  }
}

// ========== Singleton ==========

let instance: SkillToolRegistry | null = null;

export function getSkillToolRegistry(): SkillToolRegistry {
  if (!instance) {
    instance = new SkillToolRegistry();
  }
  return instance;
}
