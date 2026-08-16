/**
 * Agent Declaration Loader
 *
 * C1: 支持 agents/*.yaml 声明式 agent 配置。
 *
 * DSH 使用 agents/ 目录下的 YAML 文件来声明 agent 的：
 * - 模型选择（model, temperature, maxSteps）
 * - 工具白名单/黑名单（allowedTools, deniedTools）
 * - 技能组合（skills 列表，自动加载）
 * - 系统提示词覆盖（systemPrompt）
 * - 上下文模式（inline/fork）
 *
 * 本模块提供加载和解析能力，SkillRegistry 可通过 Provider 机制发现这些声明。
 */

import * as fs from "fs";
import * as path from "path";
import { parseSkillMarkdown, type SkillDefinition } from "./skill";

// ========== Agent Declaration Types ==========

export interface AgentDeclaration {
  /** Agent 唯一名称 */
  name: string;
  /** 人类可读描述 */
  description: string;
  /** 模型 ID 覆盖 */
  model?: string;
  /** 温度覆盖 */
  temperature?: number;
  /** 最大步数覆盖 */
  maxSteps?: number;
  /** 工具白名单（空 = 所有工具） */
  allowedTools?: string[];
  /** 工具黑名单 */
  deniedTools?: string[];
  /** 自动加载的技能列表 */
  skills?: string[];
  /** 系统提示词覆盖 */
  systemPrompt?: string;
  /** 上下文模式 */
  contextMode?: "inline" | "fork";
  /** 别名 */
  aliases?: string[];
  /** 声明文件路径 */
  filePath?: string;
  /** 来源 */
  source?: string;
}

// ========== YAML Frontmatter Parser (simplified) ==========

/**
 * 解析 agent 声明的 YAML frontmatter。
 * 复用 skill.ts 中的 YAML 解析逻辑。
 */
export function parseAgentDeclaration(
  content: string,
  filePath: string,
): AgentDeclaration | null {
  const lines = content.split(/\r?\n/);
  let inFrontmatter = false;
  let frontmatterEnd = -1;

  // 找到 frontmatter 范围
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "---" && !inFrontmatter) {
      inFrontmatter = true;
      continue;
    }
    if (line === "---" && inFrontmatter) {
      frontmatterEnd = i;
      break;
    }
  }

  if (frontmatterEnd === -1) return null;

  // 解析 frontmatter 字段
  const declaration: AgentDeclaration = {
    name: "",
    description: "",
  };

  let currentBlockArray: { key: string; items: string[] } | null = null;

  for (let i = 1; i < frontmatterEnd; i++) {
    const line = lines[i];

    // Block array item
    const blockItem = line.match(/^\s+-\s+(.+)$/);
    if (blockItem && currentBlockArray) {
      currentBlockArray.items.push(blockItem[1].trim());
      continue;
    }

    // Key-value
    const match = line.match(/^(\w+):\s*(.*)$/);
    if (match) {
      // Flush previous block array
      if (currentBlockArray) {
        (declaration as any)[currentBlockArray.key] = currentBlockArray.items;
        currentBlockArray = null;
      }

      const [, key, rawValue] = match;
      const value = rawValue.trim();

      if (key === "allowedTools" || key === "deniedTools" || key === "skills" || key === "aliases") {
        if (value.startsWith("[")) {
          // Inline array
          const inner = value.slice(1, -1).trim();
          (declaration as any)[key] = inner
            ? inner.split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""))
            : [];
        } else if (!value) {
          // Block array
          currentBlockArray = { key, items: [] };
        } else {
          (declaration as any)[key] = [value];
        }
      } else if (value === "true") {
        (declaration as any)[key] = true;
      } else if (value === "false") {
        (declaration as any)[key] = false;
      } else if (/^-?\d+(\.\d+)?$/.test(value)) {
        (declaration as any)[key] = parseFloat(value);
      } else if ((value.startsWith('"') && value.endsWith('"')) ||
                 (value.startsWith("'") && value.endsWith("'"))) {
        (declaration as any)[key] = value.slice(1, -1);
      } else if (value) {
        (declaration as any)[key] = value;
      }
    }
  }

  // Flush remaining block array
  if (currentBlockArray) {
    (declaration as any)[currentBlockArray.key] = currentBlockArray.items;
  }

  // 提取 body 作为 systemPrompt（如果有）
  const body = lines.slice(frontmatterEnd + 1).join("\n").trim();
  if (body) {
    declaration.systemPrompt = body;
  }

  declaration.filePath = filePath;
  if (!declaration.name) return null;

  return declaration;
}

// ========== Agent Declaration Loader ==========

/**
 * 从目录加载 agent 声明。
 * 扫描 agents/ 目录下的 *.yaml 和 *.md 文件。
 */
export function loadAgentDeclarations(dirPath: string): AgentDeclaration[] {
  const declarations: AgentDeclaration[] = [];

  if (!fs.existsSync(dirPath)) return declarations;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return declarations;
  }

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);

    if (entry.isFile() && (entry.name.endsWith(".yaml") || entry.name.endsWith(".yml") || entry.name.endsWith(".md"))) {
      try {
        const content = fs.readFileSync(fullPath, "utf-8");
        const decl = parseAgentDeclaration(content, fullPath);
        if (decl) {
          decl.source = "project";
          declarations.push(decl);
        }
      } catch (error) {
        console.warn(`[AgentDeclaration] Failed to parse ${fullPath}: ${error}`);
      }
    }
  }

  return declarations;
}

/**
 * 将 AgentDeclaration 转换为 SkillDefinition。
 * 这使得 agent 声明可以通过 SkillRegistry 管理。
 */
export function agentDeclarationToSkill(decl: AgentDeclaration): SkillDefinition {
  return {
    name: decl.name,
    description: decl.description,
    aliases: decl.aliases,
    allowedTools: decl.allowedTools,
    model: decl.model,
    temperature: decl.temperature,
    maxSteps: decl.maxSteps,
    prompt: decl.systemPrompt || "",
    contextMode: decl.contextMode || "inline",
    source: (decl.source as any) || "project",
    filePath: decl.filePath,
    tags: ["agent-declaration"],
    version: "1.0.0",
    forcePreload: false,
  };
}
