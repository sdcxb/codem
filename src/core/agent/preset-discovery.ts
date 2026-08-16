/**
 * Agent Preset Discovery — 目录发现 agent.cordis.yml
 *
 * 设计对标 DSH `agent-presets/discovery`。
 *
 * 一个 preset 是一个目录，包含：
 * - `agent.cordis.yml`：组合文件（agent 定义 + 工具/权限配置）
 * - `metadata.yml`（可选）：显示文本（display name, description, order）
 *
 * 发现机制：
 * - 扫描配置的根目录列表（优先级顺序）
 * - 每个根目录下扫描子目录
 * - 子目录名 = preset id
 * - 含 agent.cordis.yml 的目录 = 有效 preset
 * - 不含的 = 跳过（不报错）
 * - 同 id 先发现的根目录优先
 *
 * per-session 挂载：
 * - 会话可选择一个 preset
 * - 该 preset 的定义覆盖默认 agent 定义
 * - 挂载通过 session_meta 事件记录
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { AgentDefinition } from "./agent";

// ========== Types ==========

/** 预设根目录配置 */
export interface PresetRoot {
  /** 根目录路径 */
  path: string;
  /** 信任级别：shipped（内置）或 user（用户自定义） */
  trust: "shipped" | "user";
}

/** 发现的预设 */
export interface AgentPreset {
  /** preset id = 目录名 */
  id: string;
  /** 信任级别 */
  trust: "shipped" | "user";
  /** 组合文件路径 */
  path: string;
  /** 显示名称（来自 metadata.yml，回退到 id） */
  displayName?: string;
  /** 描述文本 */
  description?: string;
  /** 排序权重 */
  order?: number;
  /** 损坏原因（undefined = 健康） */
  broken?: string;
  /** 解析后的 agent 定义（broken 时为 null） */
  agentDefinition?: AgentDefinition | null;
}

// ========== Constants ==========

/** 组合文件名 — 对标 DSH */
export const COMPOSITION_FILE = "agent.cordis.yml";

/** 元数据文件名 */
export const METADATA_FILE = "metadata.yml";

/** preset id 正则 — 对标 DSH PRESET_ID */
const PRESET_ID = /^[a-z0-9][a-z0-9_-]*$/;

/** 用户预设目录 — 对标 DSH USER_PRESET_DIR */
export const USER_PRESET_DIR = ".agent-presets";

// ========== YAML Parsing (simplified) ==========

/**
 * 简单 YAML 解析器 — 解析 agent.cordis.yml 格式。
 * 不依赖外部 yaml 库，只处理我们需要的结构。
 */
function parseSimpleYaml(text: string): Record<string, any> | null {
  try {
    const lines = text.split("\n");
    const result: Record<string, any> = {};
    let currentSection: Record<string, any> | null = null;
    let currentKey = "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      // Top-level key
      const topMatch = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/);
      if (topMatch && !line.startsWith(" ")) {
        const key = topMatch[1];
        const value = topMatch[2];
        if (value) {
          result[key] = value;
        } else {
          result[key] = {};
          currentSection = result[key] as Record<string, any>;
          currentKey = key;
        }
        continue;
      }

      // Nested key (indented)
      if (currentSection && line.startsWith("  ")) {
        const nestedMatch = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/);
        if (nestedMatch) {
          const key = nestedMatch[1];
          const value = nestedMatch[2];
          if (value) {
            // Parse value: strip quotes, parse arrays
            const cleanValue = value.replace(/^["']|["']$/g, "");
            if (cleanValue.startsWith("[") && cleanValue.endsWith("]")) {
              const items = cleanValue
                .slice(1, -1)
                .split(",")
                .map((s) => s.trim().replace(/^["']|["']$/g, ""))
                .filter(Boolean);
              currentSection[key] = items;
            } else {
              currentSection[key] = cleanValue;
            }
          } else {
            currentSection[key] = {};
          }
        }
      }
    }

    return result;
  } catch {
    return null;
  }
}

/**
 * 解析 metadata.yml
 */
function parseMetadata(text: string): { displayName?: string; description?: string; order?: number } {
  const parsed = parseSimpleYaml(text);
  if (!parsed) return {};
  return {
    displayName: parsed.displayName || parsed.name,
    description: parsed.description,
    order: parsed.order ? parseInt(parsed.order, 10) : undefined,
  };
}

// ========== Discovery ==========

/**
 * 检查路径是否为文件
 */
async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

/**
 * 读取元数据文件（如果存在）
 */
async function readMetadata(dir: string): Promise<{ displayName?: string; description?: string; order?: number }> {
  const metaPath = path.join(dir, METADATA_FILE);
  if (!(await isFile(metaPath))) return {};
  try {
    const content = await fs.promises.readFile(metaPath, "utf8");
    return parseMetadata(content);
  } catch {
    return {};
  }
}

/**
 * 将 agent.cordis.yml 解析为 AgentDefinition
 */
function parseComposition(text: string, presetId: string): { definition: AgentDefinition } | { error: string } {
  const parsed = parseSimpleYaml(text);
  if (!parsed) {
    return { error: "cannot parse composition file" };
  }

  // 提取 agent 定义
  const name = parsed.name || presetId;
  const prompt = parsed.prompt || parsed.systemPrompt || "";
  const toolAllowlist = Array.isArray(parsed.tools) ? parsed.tools : undefined;
  const model = parsed.model || undefined;
  const temperature = parsed.temperature ? parseFloat(parsed.temperature) : undefined;
  const maxSteps = parsed.maxSteps ? parseInt(parsed.maxSteps, 10) : undefined;
  const collaborationMode = parsed.collaborationMode === "plan" ? "plan" : "default";

  const definition: AgentDefinition = {
    id: presetId,
    name,
    description: parsed.description || "",
    mode: "primary",
    prompt,
    toolAllowlist,
    permissions: [],
    model,
    temperature,
    maxSteps,
    collaborationMode: collaborationMode as any,
  };

  return { definition };
}

/**
 * 扫描一个根目录
 */
async function scanRoot(root: PresetRoot): Promise<AgentPreset[]> {
  const dir = path.resolve(root.path);
  let children: fs.Dirent[];
  try {
    children = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const found: AgentPreset[] = [];

  for (const child of children) {
    if (!child.isDirectory() || !PRESET_ID.test(child.name)) continue;

    const directory = path.join(dir, child.name);
    const compositionPath = path.join(directory, COMPOSITION_FILE);

    if (!(await isFile(compositionPath))) {
      // 目录存在但没有 composition 文件 — 跳过
      continue;
    }

    const metadata = await readMetadata(directory);
    let agentDefinition: AgentDefinition | null = null;
    let broken: string | undefined;

    try {
      const content = await fs.promises.readFile(compositionPath, "utf8");
      const result = parseComposition(content, child.name);
      if ("error" in result) {
        broken = result.error;
      } else {
        agentDefinition = result.definition;
      }
    } catch (e: any) {
      broken = `cannot read composition: ${e.message}`;
    }

    found.push({
      id: child.name,
      trust: root.trust,
      path: compositionPath,
      ...metadata,
      ...(broken ? { broken } : {}),
      agentDefinition,
    });
  }

  // 排序：先按 order，再按 id
  return found.sort((a, b) => {
    const byOrder = (a.order ?? Number.POSITIVE_INFINITY) - (b.order ?? Number.POSITIVE_INFINITY);
    return byOrder === 0 ? a.id.localeCompare(b.id) : byOrder;
  });
}

/**
 * 扫描所有根目录，先发现的优先。
 * 对标 DSH `discoverPresets(roots)`。
 */
export async function discoverPresets(roots: readonly PresetRoot[]): Promise<AgentPreset[]> {
  const byId = new Map<string, AgentPreset>();

  for (const root of roots) {
    const presets = await scanRoot(root);
    for (const preset of presets) {
      if (byId.has(preset.id)) continue; // 先发现的优先
      byId.set(preset.id, preset);
    }
  }

  return [...byId.values()];
}

// ========== Default Roots ==========

/**
 * 获取默认预设根目录列表。
 *
 * 优先级顺序：
 * 1. 用户预设目录（~/.agent-presets）— trust: user
 * 2. 应用内置预设目录 — trust: shipped
 */
export function getDefaultRoots(appDir?: string): PresetRoot[] {
  const roots: PresetRoot[] = [];

  // 用户预设目录
  const userDir = path.join(os.homedir(), USER_PRESET_DIR);
  roots.push({ path: userDir, trust: "user" });

  // 应用内置预设目录
  if (appDir) {
    roots.push({ path: path.join(appDir, "presets"), trust: "shipped" });
  }

  return roots;
}

// ========== Session-Level Mounting ==========

/**
 * 为会话选择一个 preset。
 * 记录到事件日志的 session_meta 事件中。
 */
export function selectPresetForSession(sessionId: string, presetId: string): void {
  const { getEventLog } = require("../storage/event-log");
  getEventLog().append(sessionId, "session_meta", {
    action: "preset_selected",
    presetId,
  });
}

/**
 * 读取会话选择的 preset。
 * 从事件日志中查找最后一次 preset_selected。
 */
export function getSessionPreset(sessionId: string): string | null {
  const { getEventLog } = require("../storage/event-log");
  const events = getEventLog().readAll(sessionId);
  for (let i = events.length - 1; i >= 0; i--) {
    const evt = events[i];
    if (
      evt.type === "session_meta" &&
      (evt.payload as any)?.action === "preset_selected"
    ) {
      return (evt.payload as any).presetId;
    }
  }
  return null;
}
