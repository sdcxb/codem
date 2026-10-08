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

  /**
   * **只声明、没有实现**的工具名（第 184 波 F4）。
   *
   * 技能可以在 frontmatter 里写 `tools: [{name: x}]`，但真正能让工具出现在
   * `ToolRegistry` 里的只有 Provider 工厂（内置 2 个 + `registerFactory` 注册的外部工厂）。
   * 声明了却没有工厂时，改前把这些名字塞进 `registeredToolNames` 并**原样返回**
   * ⇒ `load_skill` 据此告诉模型「这些工具现在可用」⇒ 模型调用不存在的工具、反复失败；
   * 卸载时还会对从未注册过的名字调 `toolRegistry.remove()`，**误删同名真工具**。
   *
   * 现在这些名字单独记账：`loadProvider` 对它们返回 `[]`（不谎称可用），
   * 卸载时也不碰它们。
   */
  private declaredOnlyToolNames: Map<string, string[]> = new Map();

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

    // 如果没有工厂但声明了 tools：**一个工具都没注册**（第 184 波 F4）。
    if (!factory) {
      if (skill.tools?.length) {
        const declared = skill.tools.map((t) => t.name);
        /**
         * 改前这里 `this.registeredToolNames.set(...)` 之后 `return declared` ——
         * 于是"声明"被当成"已注册"，`load_skill` 会说这些工具可用（假成功），
         * 卸载时还会 `toolRegistry.remove(同名)` 误删**真的**同名工具。
         *
         * 现在：如实记账（供 `load_skill` 说明"声明但未实现，不可调用"），返回 `[]`，
         * 调用方据此**不会**宣称任何工具可用。
         */
        this.declaredOnlyToolNames.set(skill.name, declared);
        console.warn(
          `[SkillToolRegistry] 技能 "${skill.name}" 声明了 ${declared.length} 个工具，` +
            `但没有对应的 Provider 工厂 ⇒ 这些工具本次**未注册、不可调用**：${declared.join(", ")}`,
        );
        return [];
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

    /**
     * ⚠️ 第 184 波 F4：**只移除真的注册过的名字**。
     *
     * `registeredToolNames` 现在只装"确实 `toolRegistry.register` 成功"的工具名，
     * 所以这里不会再把"仅声明"的名字当成自己的工具去 `remove()` ——
     * 那曾经会**误删同名真工具**（例如技能声明了 `read_file`，卸载时把真的 `read_file` 删掉）。
     */
    const toolNames = this.registeredToolNames.get(skillName);
    if (toolNames) {
      for (const toolName of toolNames) {
        toolRegistry.remove(toolName);
      }
      this.registeredToolNames.delete(skillName);
    }
    this.declaredOnlyToolNames.delete(skillName);
  }

  /**
   * 取"**只声明、没有实现**"的工具名（第 184 波 F4）。
   *
   * `load_skill` 用它如实告诉模型"这些工具声明了但没装上，不要调用"，
   * 而不是像改前那样把它们当成"现在可用"。
   */
  getDeclaredOnlyTools(skillName: string): string[] {
    return this.declaredOnlyToolNames.get(skillName) || [];
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
    // 只声明的技能也要清账（它们没有工具要移除，但 `declaredOnlyToolNames` 得清掉）
    const names = new Set([
      ...this.registeredToolNames.keys(),
      ...this.declaredOnlyToolNames.keys(),
    ]);
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
