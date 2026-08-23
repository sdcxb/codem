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
 * DSH 对齐：
 * - 返回 <skill_content> 结构化格式（含 <skill_resources> + <skill_instructions>）
 * - 支持 /skill-name 用户手势自动加载
 * - Catalog 每轮刷新（digest 对比 + 替换消息）
 *
 * 历史恢复：从聊天历史中恢复已加载的技能状态。
 */

import type { ToolDef, ToolContext, ToolExecuteResult } from "../tools";
import { getSkillRegistry, parseSkillMarkdown, type SkillDefinition } from "../../skill/skill";
import { getSkillToolRegistry } from "../../skill/registry";
import type { ToolRegistry } from "../tools";
import * as path from "path";

// ========== Filesystem Fallback for Skill Discovery ==========

/**
 * 从 ~/.codem/skills/<skill-name>/SKILL.md 加载技能。
 * 当技能在注册表和 Provider 中都找不到时调用。
 * 这使得 LLM 通过 write/bash 工具创建的技能能被发现和加载。
 */
async function loadSkillFromFilesystem(skillName: string): Promise<SkillDefinition | undefined> {
  try {
    const { readFile, listDirectory, getAppDataDir } = await import("../../file-api");
    // 获取 app data 目录
    const invoke = (window as any)?.__TAURI__?.core?.invoke;
    if (!invoke) return undefined;
    const dataDir = await getAppDataDir();
    const sep = dataDir.includes("/") && !dataDir.includes("\\") ? "/" : "\\";
    const skillsDir = `${dataDir}.codem${sep}skills`;
    const skillDir = `${skillsDir}${sep}${skillName}`;
    const skillMdPath = `${skillDir}${sep}SKILL.md`;
    // 尝试读取 SKILL.md
    const content = await readFile(skillMdPath);
    const skill = parseSkillMarkdown(content, skillMdPath);
    if (skill) {
      skill.source = "user";
      skill.filePath = skillDir;
      skill.enabled = true;
      // 注册到注册表以便后续调用直接命中
      getSkillRegistry().register(skill);
      console.log(`[load_skill] Discovered skill "${skillName}" from filesystem: ${skillMdPath}`);
      return skill;
    }
  } catch {
    // 文件不存在或读取失败
  }
  return undefined;
}

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
      sections.push(renderSkillContent(skill));
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

// ========== DSH-aligned <skill_content> rendering ==========

/**
 * 转义 XML 属性值中的特殊字符。
 */
function escapeAttr(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

/**
 * 转义 XML 文本内容中的特殊字符。
 */
function escapeText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * 渲染 skill 的资源提示信息。
 */
function renderResourceHint(skill: SkillDefinition): string[] {
  if (skill.filePath) {
    const baseDir = skill.filePath.replace(/[/\\]SKILL\.md$/i, "");
    return [
      `Base directory for this skill: ${escapeText(baseDir)}`,
      "Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.",
    ];
  }
  return [
    `Resources for this skill are managed internally.`,
    "Load referenced resources only as needed.",
  ];
}

/**
 * 渲染一个已加载的技能为 <skill_content> 格式（DSH-aligned）。
 * 模型看到统一的结构化包装，不管技能是从工具调用还是 /skill-name 手势加载的。
 */
export function renderSkillContent(skill: SkillDefinition): string {
  const resourceHint = renderResourceHint(skill);
  return [
    `<skill_content name="${escapeAttr(skill.name)}">`,
    "<skill_resources>",
    ...resourceHint,
    "</skill_resources>",
    "",
    "<skill_instructions>",
    skill.prompt,
    "</skill_instructions>",
    "</skill_content>",
  ].join("\n");
}

// ========== Catalog digest (差距 3: 每轮刷新) ==========

interface CatalogEntry {
  name: string;
  description: string;
}

/**
 * 计算 catalog 的 digest（SHA-256）。
 * 只有 entries 变化才会触发重新注入。
 */
async function digestCatalogEntries(entries: CatalogEntry[]): Promise<string> {
  const canonical = entries.map(e => JSON.stringify([e.name, e.description])).join("\n");
  const encoder = new TextEncoder();
  const data = encoder.encode(canonical);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

/** 会话级 catalog 历史 — 记录上次注入的 digest，避免重复注入 */
const catalogHistory = new Map<string, { digest: string; published: boolean }>();

/**
 * 构建 catalog 消息文本。
 * 在每轮对话开始时调用，通过 digest 对比决定是否注入。
 *
 * @param sessionId 会话 ID
 * @returns catalog 消息文本，空字符串表示未变更无需注入
 */
export async function buildCatalogMessage(sessionId: string): Promise<string> {
  const registry = getSkillRegistry();
  const allSkills = registry.getAll().filter((s) => s.enabled !== false);

  const entries: CatalogEntry[] = allSkills.map(s => ({
    name: s.name,
    description: s.description.length > 500
      ? s.description.slice(0, 497) + "..."
      : s.description,
  }));

  const digest = await digestCatalogEntries(entries);
  const history = catalogHistory.get(sessionId);

  // 未变更 — 不注入
  if (history && history.digest === digest) {
    return "";
  }

  // 更新历史
  catalogHistory.set(sessionId, { digest, published: true });

  const isFirst = !history?.published;
  const catalogLines = entries.map(e => `- \`${e.name}\`: ${escapeText(e.description)}`);

  if (isFirst) {
    return [
      "<system-reminder>",
      "A skill is a reusable set of task-specific instructions. The following skills are available in this session:",
      "",
      "<available_skills>",
      ...catalogLines,
      "</available_skills>",
      "",
      "If the user names a skill, or the task clearly matches a skill's description, call the `load_skill` tool with the exact skill name before taking task actions. Load all applicable skills, then follow their full instructions. This catalog contains summaries only; do not infer or follow a skill's instructions until it has been loaded.",
      "A user may also invoke a skill directly by typing /skill-name; its <skill_content> block then appears in this conversation. Follow it, and do not call the `load_skill` tool again for that skill.",
      "</system-reminder>",
    ].join("\n");
  } else {
    // 替换 catalog
    return [
      "<system-reminder>",
      "The available skill catalog changed. This complete catalog replaces every earlier available-skills list in this session:",
      "",
      "<available_skills>",
      ...catalogLines,
      "</available_skills>",
      "",
      entries.length === 0
        ? "No skills are currently available through the `load_skill` tool. Do not use names from earlier skill catalogs."
        : "Use only names in this replacement catalog. If the user names a listed skill, or the task clearly matches its description, call the `load_skill` tool with the exact name before acting.",
      "A user may also invoke a skill directly by typing /skill-name; its <skill_content> block then appears in this conversation. Follow it, and do not call the `load_skill` tool again for that skill.",
      "</system-reminder>",
    ].join("\n");
  }
}

/**
 * 清除会话的 catalog 历史（会话结束时调用）。
 */
export function clearCatalogHistory(sessionId: string): void {
  catalogHistory.delete(sessionId);
}

// ========== 差距 2: /skill-name 用户手势 ==========

/**
 * 匹配 /skill-name 手势的正则。
 * 空白分隔的 /kebab-case-name，避免匹配文件路径和分数。
 */
const SKILL_GESTURE = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g;

/**
 * 从用户消息中提取 /skill-name 手势。
 * 返回去重后的技能名列表（未验证，仅提取候选）。
 */
export function extractSkillGestures(message: string): string[] {
  const names: string[] = [];
  for (const match of message.matchAll(SKILL_GESTURE)) {
    const name = match[2];
    if (name !== undefined && !names.includes(name)) {
      names.push(name);
    }
  }
  return names;
}

/**
 * 处理用户消息中的 /skill-name 手势。
 * 如果找到匹配的技能，注入 <skill_content> 到会话。
 *
 * @param sessionId 会话 ID
 * @param userMessage 用户消息原文
 * @returns 要注入的 <skill_content> 文本，空字符串表示无手势
 */
export function processSkillGestures(sessionId: string, userMessage: string): string {
  const gestureNames = extractSkillGestures(userMessage);
  if (gestureNames.length === 0) return "";

  const registry = getSkillRegistry();
  const injections: string[] = [];

  for (const name of gestureNames) {
    // 先查名称，再查别名
    let skill = registry.get(name);
    if (!skill) {
      skill = registry.getByAlias(name);
    }

    if (!skill) {
      // 技能不存在 — 保持为普通文本
      continue;
    }

    // 加载到会话缓存
    const result = sessionCache.load(sessionId, skill.name, skill.prompt, 0);
    if (result.cached) {
      // 已加载，不需要重新注入
      continue;
    }

    // 注入 <skill_content>
    injections.push(renderSkillContent(skill));

    // 如果技能有 Provider，加载工具
    if (skill.provider || skill.tools?.length) {
      // 异步加载，不阻塞
      const skillToolRegistry = getSkillToolRegistry();
      // 工具注册需要 ToolRegistry，但手势处理在 agentic-loop 之前
      // 工具会在下一轮 load_skill 调用时加载
      console.log(`[load_skill] Skill "${skill.name}" invoked via /${name} gesture, tools will be loaded on next call`);
    }
  }

  if (injections.length === 0) return "";

  return `\n\n## Skill Invoked by User\n\n${injections.join("\n\n")}`;
}

// ========== Tool Definition ==========

/**
 * 创建 load_skill 工具。
 * 需要传入 ToolRegistry 以便动态注册技能工具。
 */
export function createLoadSkillTool(toolRegistry: ToolRegistry): ToolDef {
  return {
    id: "load_skill",
    guidance: "Use load_skill to activate a skill by name. Skills provide specialized instructions and capabilities. After loading, follow the skill's instructions.",
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

      // 查找技能（支持别名）— 先查本地 builtin/runtime
      let skill = registry.get(skillName);
      if (!skill) {
        skill = registry.getByAlias(skillName);
      }

      // A4: 如果本地没找到，尝试从 Provider 异步加载
      if (!skill) {
        try {
          skill = await registry.getSkill(skillName) ?? undefined;
        } catch {
          // Provider 查询失败，继续走 catalog 流程
        }
      }

      // Filesystem fallback: 尝试从 ~/.codem/skills/ 目录加载
      // 这使得 LLM 通过 write/bash 工具创建的技能能被发现
      if (!skill) {
        skill = await loadSkillFromFilesystem(skillName);
      }

      if (!skill) {
        // A4: Catalog 模式 — 返回 DSH 风格的技能目录
        const allSkills = registry.getAll().filter((s) => s.enabled !== false);
        const catalogEntries = allSkills.map((s) => {
          const parts = [`${s.name}`];
          if (s.description) parts.push(s.description);
          if (s.whenToUse) parts.push(`whenToUse: ${s.whenToUse}`);
          return parts.join(" — ");
        });

        // 也尝试从 Provider 获取 catalog
        let providerCatalog = "";
        try {
          const summaries = await registry.listSummaries();
          const externalSummaries = summaries.filter(
            (s) => !allSkills.some((b) => b.name === s.name)
          );
          if (externalSummaries.length > 0) {
            providerCatalog = "\n\nExternal skills:\n" +
              externalSummaries.map((s) => {
                const parts = [s.name];
                if (s.description) parts.push(s.description);
                return parts.join(" — ");
              }).join("\n");
          }
        } catch {
          // Provider catalog 查询失败，忽略
        }

        return {
          title: "load_skill",
          output: `Skill "${skillName}" not found. Available skills:\n${catalogEntries.join("\n")}${providerCatalog}`,
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

      // 首次加载：注入 <skill_content> 结构化格式（差距 1: DSH-aligned）
      const skillContent = renderSkillContent(skill);
      pendingPromptInjections.set(
        ctx.sessionId,
        (pendingPromptInjections.get(ctx.sessionId) || "") + "\n\n" + skillContent,
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
