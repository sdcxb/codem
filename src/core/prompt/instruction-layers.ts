/**
 * Agent Instruction Layers — 代理指令分层加载
 *
 * 设计对标 DSH `context/agent-instructions`。
 *
 * R3-2.4: 分层加载系统提示词，支持四级覆盖：
 *
 * 1. Global    — 全局指令（~/.codem/instructions.md）— 所有项目通用
 * 2. Deploy    — 部署指令（部署级别，如 dev/staging/prod）
 * 3. Project   — 项目指令（<project>/.codem/instructions.md）— 当前项目专用
 * 4. Session   — 会话指令（运行时注入，如用户临时要求）
 *
 * 加载顺序：Global → Deploy → Project → Session
 * 后层可覆盖前层的内容。最终结果合并为一个指令字符串。
 */

// ========== Types ==========

export type InstructionLayer = "global" | "deploy" | "project" | "session";

export interface InstructionEntry {
  layer: InstructionLayer;
  source: string;
  content: string;
  /** 优先级（数字越大优先级越高，后加载的覆盖先加载的） */
  priority: number;
}

export interface LayeredInstructions {
  entries: InstructionEntry[];
  /** 合并后的指令字符串 */
  combined: string;
}

// ========== Layer Loaders ==========

/**
 * 加载全局指令文件。
 * 路径：~/.codem/instructions.md
 */
async function loadGlobalInstructions(): Promise<InstructionEntry | null> {
  try {
    const { readFile } = await import("../file-api");
    const path = await getGlobalInstructionsPath();
    if (!path) return null;
    const content = await readFile(path);
    if (!content || !content.trim()) return null;
    return {
      layer: "global",
      source: path,
      content: content.trim(),
      priority: 1,
    };
  } catch {
    return null;
  }
}

/**
 * 加载部署指令。
 * 来源：环境变量 CODEM_DEPLOY_INSTRUCTIONS 或部署配置
 */
async function loadDeployInstructions(): Promise<InstructionEntry | null> {
  try {
    const deployInstructions = process.env.CODEM_DEPLOY_INSTRUCTIONS;
    if (!deployInstructions || !deployInstructions.trim()) return null;
    return {
      layer: "deploy",
      source: "env:CODEM_DEPLOY_INSTRUCTIONS",
      content: deployInstructions.trim(),
      priority: 2,
    };
  } catch {
    return null;
  }
}

/**
 * 加载项目指令文件。
 * 路径：<project>/.codem/instructions.md 或 <project>/.cursor/rules
 */
async function loadProjectInstructions(cwd: string): Promise<InstructionEntry | null> {
  try {
    const { readFile, exists } = await import("../file-api");
    const candidates = [
      `${cwd}/.codem/instructions.md`,
      `${cwd}/.cursor/rules`,
      `${cwd}/CLAUDE.md`,
      `${cwd}/.github/copilot-instructions.md`,
    ];
    for (const path of candidates) {
      if (await exists(path)) {
        const content = await readFile(path);
        if (content && content.trim()) {
          return {
            layer: "project",
            source: path,
            content: content.trim(),
            priority: 3,
          };
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 加载会话指令。
 * 来源：运行时注入（用户临时要求、plan mode 等）
 */
function loadSessionInstructions(sessionInstructions?: string): InstructionEntry | null {
  if (!sessionInstructions || !sessionInstructions.trim()) return null;
  return {
    layer: "session",
    source: "runtime:session",
    content: sessionInstructions.trim(),
    priority: 4,
  };
}

// ========== Path Resolution ==========

async function getGlobalInstructionsPath(): Promise<string | null> {
  try {
    const home = process.env.USERPROFILE || process.env.HOME || "";
    if (!home) return null;
    const candidates = [
      `${home}/.codem/instructions.md`,
      `${home}/.codem/agent-instructions.md`,
    ];
    const { exists } = await import("../file-api");
    for (const p of candidates) {
      if (await exists(p)) return p;
    }
    return null;
  } catch {
    return null;
  }
}

// ========== Combined Loader ==========

/**
 * R3-2.4: 分层加载所有指令。
 *
 * 加载顺序：Global → Deploy → Project → Session
 * 合并策略：各层指令以 "# <Layer> Instructions" 标题分隔，
 * 后层优先级更高（如果内容冲突，后层的指令应被模型优先遵从）。
 *
 * @param cwd 当前工作目录
 * @param sessionInstructions 可选的会话级指令
 * @returns 合并后的分层指令
 */
export async function loadLayeredInstructions(
  cwd: string,
  sessionInstructions?: string,
): Promise<LayeredInstructions> {
  const entries: InstructionEntry[] = [];

  // 1. Global
  const global = await loadGlobalInstructions();
  if (global) entries.push(global);

  // 2. Deploy
  const deploy = await loadDeployInstructions();
  if (deploy) entries.push(deploy);

  // 3. Project
  const project = await loadProjectInstructions(cwd);
  if (project) entries.push(project);

  // 4. Session
  const session = loadSessionInstructions(sessionInstructions);
  if (session) entries.push(session);

  // Combine with layer headers
  const parts: string[] = [];
  for (const entry of entries) {
    const layerName = entry.layer.charAt(0).toUpperCase() + entry.layer.slice(1);
    parts.push(`# ${layerName} Instructions\n\n${entry.content}`);
  }

  return {
    entries,
    combined: parts.join("\n\n---\n\n"),
  };
}

/**
 * 同步版本：仅加载环境变量和会话级指令（不涉及文件 I/O）。
 * 用于快速路径（如缓存命中时）。
 */
export function loadLayeredInstructionsSync(
  sessionInstructions?: string,
): LayeredInstructions {
  const entries: InstructionEntry[] = [];

  // Deploy (env var is sync-readable)
  const deployInstructions = process.env.CODEM_DEPLOY_INSTRUCTIONS;
  if (deployInstructions && deployInstructions.trim()) {
    entries.push({
      layer: "deploy",
      source: "env:CODEM_DEPLOY_INSTRUCTIONS",
      content: deployInstructions.trim(),
      priority: 2,
    });
  }

  // Session
  const session = loadSessionInstructions(sessionInstructions);
  if (session) entries.push(session);

  const parts = entries.map(e => {
    const name = e.layer.charAt(0).toUpperCase() + e.layer.slice(1);
    return `# ${name} Instructions\n\n${e.content}`;
  });

  return {
    entries,
    combined: parts.join("\n\n---\n\n"),
  };
}

// ========== Cache ==========

let cachedProjectInstructions: { cwd: string; entry: InstructionEntry } | null = null;

/**
 * 带缓存的项目指令加载。
 * 当 cwd 不变时直接返回缓存。
 */
export async function loadProjectInstructionsCached(cwd: string): Promise<InstructionEntry | null> {
  if (cachedProjectInstructions && cachedProjectInstructions.cwd === cwd) {
    return cachedProjectInstructions.entry;
  }
  const entry = await loadProjectInstructions(cwd);
  if (entry) {
    cachedProjectInstructions = { cwd, entry };
  }
  return entry;
}

/** 清除项目指令缓存（项目切换时调用） */
export function clearProjectInstructionsCache(): void {
  cachedProjectInstructions = null;
}
