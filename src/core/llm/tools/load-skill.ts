/**
 * load_skill 工具 — LLM 按需加载技能 prompt。
 *
 * 工作机制：
 * 1. LLM 调用 load_skill(skill_name)
 * 2. 检查会话级缓存 — 已缓存则返回确认消息
 * 3. 未缓存则获取技能 prompt，注入到当前会话
 * 4. 如果技能有 Provider，加载工具到 ToolRegistry
 * 5. 技能保持 N 轮（默认 5），超时自动卸载
 *
 * 历史恢复：从聊天历史中恢复已加载的技能状态。
 */

import type { ToolDef, ToolContext, ToolExecuteResult } from "../tools";
import { getSkillRegistry } from "../../skill/skill";
import { getSkillToolRegistry } from "../../skill/registry";
import type { ToolRegistry } from "../tools";

// ========== Session-level Skill Cache ==========

interface LoadedSkillEntry {
  /** 技能名 */
  skillName: string;
  /** 加载时的迭代轮次 */
  loadedAtIteration: number;
  /** 剩余保持轮次（每轮递减，到 0 自动卸载） */
  remainingTurns: number;
  /** 注入的 prompt 内容（用于去重） */
  promptSnippet: string;
}

/**
 * 会话级技能缓存。
 * 每个会话独立维护已加载的技能列表。
 */
class SessionSkillCache {
  /** sessionId → 已加载技能列表 */
  private sessions: Map<string, LoadedSkillEntry[]> = new Map();

  /** 默认保持轮次 */
  private readonly defaultTtl = 5;

  /**
   * 加载一个技能到会话缓存。
   * @returns null 表示首次加载（需要注入 prompt），string 表示已缓存（返回确认消息）
   */
  load(sessionId: string, skillName: string, prompt: string, currentIteration: number): { cached: boolean; message: string } {
    let entries = this.sessions.get(sessionId);
    if (!entries) {
      entries = [];
      this.sessions.set(sessionId, entries);
    }

    // 检查是否已缓存
    const existing = entries.find((e) => e.skillName === skillName);
    if (existing) {
      // 刷新 TTL
      existing.remainingTurns = this.defaultTtl;
      existing.loadedAtIteration = currentIteration;
      return {
        cached: true,
        message: `Skill "${skillName}" is already loaded. Instructions are active in context.`,
      };
    }

    // 首次加载
    entries.push({
      skillName,
      loadedAtIteration: currentIteration,
      remainingTurns: this.defaultTtl,
      promptSnippet: prompt.substring(0, 100),
    });

    return {
      cached: false,
      message: `Skill "${skillName}" loaded successfully. Instructions are now active in context.`,
    };
  }

  /**
   * 检查技能是否已加载。
   */
  isLoaded(sessionId: string, skillName: string): boolean {
    const entries = this.sessions.get(sessionId);
    return !!entries?.some((e) => e.skillName === skillName);
  }

  /**
   * 获取会话中已加载的所有技能名。
   */
  getLoadedSkills(sessionId: string): string[] {
    const entries = this.sessions.get(sessionId);
    return entries ? entries.map((e) => e.skillName) : [];
  }

  /**
   * 递减所有技能的 TTL，返回需要卸载的技能名。
   */
  tick(sessionId: string): string[] {
    const entries = this.sessions.get(sessionId);
    if (!entries) return [];

    const toUnload: string[] = [];
    for (const entry of entries) {
      entry.remainingTurns--;
      if (entry.remainingTurns <= 0) {
        toUnload.push(entry.skillName);
      }
    }

    // 移除过期技能
    if (toUnload.length > 0) {
      const remaining = entries.filter((e) => !toUnload.includes(e.skillName));
      if (remaining.length > 0) {
        this.sessions.set(sessionId, remaining);
      } else {
        this.sessions.delete(sessionId);
      }
    }

    return toUnload;
  }

  /**
   * 卸载指定技能。
   */
  unload(sessionId: string, skillName: string): boolean {
    const entries = this.sessions.get(sessionId);
    if (!entries) return false;
    const remaining = entries.filter((e) => e.skillName !== skillName);
    if (remaining.length === entries.length) return false;
    if (remaining.length > 0) {
      this.sessions.set(sessionId, remaining);
    } else {
      this.sessions.delete(sessionId);
    }
    return true;
  }

  /**
   * 清除会话的所有技能。
   */
  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}

// ========== Singleton ==========

const sessionCache = new SessionSkillCache();

// ========== Prompt Injection Storage ==========

/**
 * 存储已加载技能的 prompt，供 agentic-loop 在构建消息时注入。
 * key: sessionId, value: 要注入的 prompt 文本
 */
const pendingPromptInjections = new Map<string, string>();

/**
 * 取出并清除待注入的技能 prompt。
 * 在 agentic-loop 的 executeIteration 中调用。
 */
export function consumePendingSkillPrompts(sessionId: string): string {
  const prompt = pendingPromptInjections.get(sessionId);
  if (prompt) {
    pendingPromptInjections.delete(sessionId);
    return prompt;
  }
  return "";
}

/**
 * 获取当前已加载技能的 prompt（不清除，用于恢复）。
 */
export function getLoadedSkillPrompts(sessionId: string): string {
  const skillNames = sessionCache.getLoadedSkills(sessionId);
  if (skillNames.length === 0) return "";

  const registry = getSkillRegistry();
  const sections: string[] = [];
  for (const name of skillNames) {
    const skill = registry.get(name);
    if (skill) {
      sections.push(`### Skill: ${skill.name}\n\n${skill.prompt}`);
    }
  }
  return sections.length > 0 ? `\n\n## Active Skill Instructions\n\n${sections.join("\n\n")}` : "";
}

/**
 * 递减技能 TTL 并卸载过期的。
 * 在 agentic-loop 每轮迭代结束时调用。
 */
export async function tickSessionSkills(sessionId: string, toolRegistry: ToolRegistry): Promise<void> {
  const toUnload = sessionCache.tick(sessionId);
  if (toUnload.length === 0) return;

  const skillToolRegistry = getSkillToolRegistry();
  for (const skillName of toUnload) {
    await skillToolRegistry.unloadProvider(skillName, toolRegistry);
    console.log(`[load_skill] Skill "${skillName}" expired and unloaded.`);
  }
}

// ========== Tool Definition ==========

/**
 * 创建 load_skill 工具。
 * 需要传入 ToolRegistry 以便动态注册技能工具。
 */
export function createLoadSkillTool(toolRegistry: ToolRegistry): ToolDef {
  return {
    id: "load_skill",
    description:
      "Load a skill by name to get its full instructions and tools. " +
      "Use this when you need detailed guidance for a specific task. " +
      "The skill instructions will be active for several turns, then automatically unloaded.",
    parameters: {
      type: "object",
      properties: {
        skill_name: {
          type: "string",
          description: "The name of the skill to load. Check available skills in the system prompt.",
        },
      },
      required: ["skill_name"],
    },
    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolExecuteResult> {
      const skillName = args.skill_name as string;
      if (!skillName) {
        return {
          title: "load_skill",
          output: "Error: skill_name is required.",
        };
      }

      const registry = getSkillRegistry();

      // 查找技能（支持别名）
      let skill = registry.get(skillName);
      if (!skill) {
        skill = registry.getByAlias(skillName);
      }

      if (!skill) {
        // 列出可用技能帮助 LLM 选择
        const allSkills = registry.getAll().filter((s) => s.enabled !== false);
        const skillList = allSkills.map((s) => `  - ${s.name}: ${s.description}`).join("\n");
        return {
          title: "load_skill",
          output: `Skill "${skillName}" not found. Available skills:\n${skillList}`,
        };
      }

      // 检查是否已加载
      const result = sessionCache.load(ctx.sessionId, skill.name, skill.prompt, 0);

      if (result.cached) {
        return {
          title: `load_skill: ${skill.name}`,
          output: result.message,
        };
      }

      // 首次加载：注入 prompt
      const promptText = `### Skill: ${skill.name}\n\n${skill.prompt}`;
      pendingPromptInjections.set(
        ctx.sessionId,
        (pendingPromptInjections.get(ctx.sessionId) || "") + "\n\n" + promptText,
      );

      // 如果技能有 Provider，加载工具
      const skillToolRegistry = getSkillToolRegistry();
      let loadedTools: string[] = [];
      if (skill.provider || skill.tools?.length) {
        try {
          const skillDir = skill.filePath
            ? skill.filePath.replace(/[/\\]SKILL\.md$/i, "")
            : "";
          loadedTools = await skillToolRegistry.loadProvider(skill, skillDir, toolRegistry);
        } catch (err: any) {
          console.error(`[load_skill] Failed to load provider for "${skill.name}":`, err.message);
        }
      }

      const toolInfo = loadedTools.length > 0
        ? `\n\nTools from this skill are now available: ${loadedTools.join(", ")}`
        : "";

      return {
        title: `load_skill: ${skill.name}`,
        output: `${result.message}${toolInfo}`,
        metadata: { skillName: skill.name, tools: loadedTools },
      };
    },
  };
}

// ========== Export for testing ==========

export { sessionCache };
