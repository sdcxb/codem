/**
 * P3-27: Skill Sandbox — 增强的技能安装安全沙箱
 *
 * 在已有的 SkillMarketClient + Installer 基础设施之上，增加：
 *
 * 1. 内容预检 (Pre-install Audit)：在安装前扫描 SKILL.md 和所有文件内容，
 *    检测潜在恶意代码模式（如远程脚本加载、隐藏 iframe、eval 调用等）。
 *
 * 2. 哈希签名验证 (Hash Verification)：记录已安装技能的内容哈希，
 *    检测安装后被篡改的情况。
 *
 * 3. 安装审计日志 (Install Audit Log)：记录每次安装/卸载操作的元数据，
 *    便于事后追溯。
 *
 * 4. 沙箱权限声明 (Permission Declaration)：技能在 SKILL.md 中声明
 *    所需权限（如 file:read, command:exec），安装时展示给用户确认。
 *
 * 安全模型：
 * - 所有从远程市场下载的技能都经过沙箱审计
 * - 审计结果分为 safe / warning / danger 三个等级
 * - warning 级别需要用户确认安装
 * - danger 级别阻止安装
 */

import { getSettingJSON, setSettingJSON } from "../storage/settings";
import type { SkillDefinition } from "./skill";

// ========== Types ==========

export type AuditLevel = "safe" | "warning" | "danger";

export interface AuditFinding {
  level: AuditLevel;
  category: string;
  message: string;
  /** 关联的文件路径 */
  filePath?: string;
  /** 匹配的内容片段（截断） */
  snippet?: string;
}

export interface SkillAuditResult {
  /** 总体安全等级（取所有 finding 的最高级别） */
  overall: AuditLevel;
  /** 所有发现的安全问题 */
  findings: AuditFinding[];
  /** 技能声明的权限 */
  declaredPermissions: string[];
  /** 审计时间戳 */
  timestamp: number;
}

export interface InstallAuditEntry {
  /** 技能名称 */
  skillName: string;
  /** 来源市场 ID */
  sourceId?: string;
  /** 安装时间 */
  installedAt: number;
  /** 审计结果摘要 */
  auditLevel: AuditLevel;
  /** 安装的文件数 */
  filesWritten: number;
  /** 内容哈希 */
  contentHash: string;
  /** 版本号 */
  version?: string;
  /** 作者 */
  author?: string;
}

// ========== Malicious Pattern Detection ==========

/** 危险模式 — 可能导致远程代码执行或数据泄露 */
const DANGER_PATTERNS: Array<{ pattern: RegExp; category: string; message: string }> = [
  {
    pattern: /eval\s*\(/gi,
    category: "rce",
    message: "检测到 eval() 调用 — 可能导致任意代码执行",
  },
  {
    pattern: /new\s+Function\s*\(/gi,
    category: "rce",
    message: "检测到 new Function() 构造 — 可能导致任意代码执行",
  },
  {
    pattern: /document\.write\s*\(/gi,
    category: "xss",
    message: "检测到 document.write() — 可能导致 XSS 注入",
  },
  {
    pattern: /<iframe[^>]*\bsrc\s*=\s*["']https?:\/\//gi,
    category: "remote-load",
    message: "检测到远程 iframe 加载 — 可能在技能运行时加载外部内容",
  },
  {
    pattern: /<script[^>]*\bsrc\s*=\s*["']https?:\/\//gi,
    category: "remote-load",
    message: "检测到远程脚本加载 — 可能在技能运行时执行外部代码",
  },
  {
    pattern: /require\s*\(\s*["']child_process["']\s*\)/gi,
    category: "rce",
    message: "检测到 child_process 引用 — 可能执行系统命令",
  },
  {
    pattern: /import\s+.*["']child_process["']/gi,
    category: "rce",
    message: "检测到 child_process 导入 — 可能执行系统命令",
  },
  {
    pattern: /\bexec\s*\(\s*["'`]/gi,
    category: "rce",
    message: "检测到 exec() 调用 — 可能执行系统命令",
  },
  {
    pattern: /\bprocess\.env\b/gi,
    category: "data-exfil",
    message: "检测到环境变量访问 — 可能泄露敏感配置",
  },
  {
    pattern: /\bfetch\s*\(\s*["']https?:\/\//gi,
    category: "network",
    message: "检测到网络请求 — 技能可能在运行时访问外部服务",
  },
  {
    pattern: /\bXMLHttpRequest\b/gi,
    category: "network",
    message: "检测到 XMLHttpRequest — 技能可能在运行时访问外部服务",
  },
  {
    pattern: /\bWebSocket\b/gi,
    category: "network",
    message: "检测到 WebSocket — 技能可能在运行时建立持久网络连接",
  },
];

/** 警告模式 — 可能是误用但不一定恶意 */
const WARNING_PATTERNS: Array<{ pattern: RegExp; category: string; message: string }> = [
  {
    pattern: /\bbase64\b/gi,
    category: "encoding",
    message: "检测到 Base64 编码内容 — 可能包含隐藏数据",
  },
  {
    pattern: /\batob\s*\(/gi,
    category: "encoding",
    message: "检测到 atob() 调用 — 可能解码隐藏内容",
  },
  {
    pattern: /\bbtoa\s*\(/gi,
    category: "encoding",
    message: "检测到 btoa() 调用 — 可能编码数据用于传输",
  },
  {
    pattern: /<object\s/gi,
    category: "embed",
    message: "检测到 <object> 标签 — 可能嵌入外部内容",
  },
  {
    pattern: /\bwindow\.open\s*\(/gi,
    category: "navigation",
    message: "检测到 window.open() — 可能打开外部链接",
  },
  {
    pattern: /<a\s+[^>]*\bhref\s*=\s*["']javascript:/gi,
    category: "xss",
    message: "检测到 javascript: URL — 可能导致 XSS",
  },
  {
    pattern: /\blocalStorage\b/gi,
    category: "storage",
    message: "检测到 localStorage 访问 — 技能可能读写本地存储",
  },
  {
    pattern: /\bindexedDB\b/gi,
    category: "storage",
    message: "检测到 indexedDB 访问 — 技能可能操作本地数据库",
  },
];

// ========== Permission Extraction ==========

/** 从 SKILL.md frontmatter 中提取权限声明 */
function extractPermissions(skillMdContent: string): string[] {
  const permissions: string[] = [];
  // 匹配 frontmatter 中的 permissions 字段
  const permMatch = skillMdContent.match(/^---\s*\n[\s\S]*?permissions\s*:\s*\n([\s\S]*?)^---/m);
  if (permMatch) {
    const permBlock = permMatch[1];
    const items = permBlock.match(/-\s+(.+)/g);
    if (items) {
      for (const item of items) {
        const perm = item.replace(/^-\s+/, "").trim();
        if (perm) permissions.push(perm);
      }
    }
  }
  // 也尝试单行格式 permissions: [a, b, c]
  const inlineMatch = skillMdContent.match(/^---\s*\n[\s\S]*?permissions\s*:\s*\[([^\]]+)\]/m);
  if (inlineMatch) {
    for (const perm of inlineMatch[1].split(",")) {
      const trimmed = perm.trim().replace(/^["']|["']$/g, "");
      if (trimmed && !permissions.includes(trimmed)) permissions.push(trimmed);
    }
  }
  return permissions;
}

// ========== Core Audit Function ==========

/**
 * 审计单个文件内容，返回发现的问题。
 */
function auditFileContent(
  content: string,
  filePath: string,
): AuditFinding[] {
  const findings: AuditFinding[] = [];

  // 检查危险模式
  for (const { pattern, category, message } of DANGER_PATTERNS) {
    const match = content.match(pattern);
    if (match) {
      const idx = match.index || 0;
      const start = Math.max(0, idx - 20);
      const end = Math.min(content.length, idx + match[0].length + 20);
      findings.push({
        level: "danger",
        category,
        message,
        filePath,
        snippet: content.substring(start, end).trim(),
      });
    }
  }

  // 检查警告模式
  for (const { pattern, category, message } of WARNING_PATTERNS) {
    const match = content.match(pattern);
    if (match) {
      const idx = match.index || 0;
      const start = Math.max(0, idx - 20);
      const end = Math.min(content.length, idx + match[0].length + 20);
      findings.push({
        level: "warning",
        category,
        message,
        filePath,
        snippet: content.substring(start, end).trim(),
      });
    }
  }

  return findings;
}

/**
 * 对技能安装包进行全面安全审计。
 *
 * @param files 文件名到内容的映射
 * @param skillMdContent SKILL.md 的文本内容
 * @returns 审计结果
 */
export function auditSkillInstallation(
  files: Map<string, string>,
  skillMdContent: string,
): SkillAuditResult {
  const allFindings: AuditFinding[] = [];
  const declaredPermissions = extractPermissions(skillMdContent);

  // 审计 SKILL.md 自身
  allFindings.push(...auditFileContent(skillMdContent, "SKILL.md"));

  // 审计每个文件
  for (const [filePath, content] of files.entries()) {
    // 跳过二进制文件（图片等）
    const ext = filePath.substring(filePath.lastIndexOf(".")).toLowerCase();
    if ([".png", ".jpg", ".jpeg", ".gif", ".ico", ".svg"].includes(ext)) {
      // SVG 可能包含脚本，仍然审计
      if (ext === ".svg") {
        allFindings.push(...auditFileContent(content, filePath));
      }
      continue;
    }
    allFindings.push(...auditFileContent(content, filePath));
  }

  // 如果技能声明了危险权限，添加警告
  const dangerPerms = declaredPermissions.filter(p =>
    p.includes("command") || p.includes("exec") || p.includes("network") || p.includes("shell")
  );
  for (const perm of dangerPerms) {
    allFindings.push({
      level: "warning",
      category: "permission",
      message: `技能声明了权限: ${perm}`,
    });
  }

  // 确定总体等级
  let overall: AuditLevel = "safe";
  if (allFindings.some(f => f.level === "danger")) {
    overall = "danger";
  } else if (allFindings.some(f => f.level === "warning")) {
    overall = "warning";
  }

  // 去重（同一文件同一类别只保留一条）
  const seen = new Set<string>();
  const uniqueFindings = allFindings.filter(f => {
    const key = `${f.filePath}:${f.category}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    overall,
    findings: uniqueFindings,
    declaredPermissions,
    timestamp: Date.now(),
  };
}

// ========== Content Hashing ==========

/**
 * 计算技能内容的简单哈希（用于篡改检测）。
 * 使用 DJB2 哈希算法 — 轻量且无需 crypto API。
 */
export function computeContentHash(files: Map<string, string>): string {
  let hash = 5381;
  // 按文件名排序确保顺序一致
  const sortedPaths = Array.from(files.keys()).sort();
  for (const path of sortedPaths) {
    const content = files.get(path) || "";
    for (let i = 0; i < content.length; i++) {
      hash = ((hash << 5) + hash + content.charCodeAt(i)) & 0xFFFFFFFF;
    }
    // 加入路径名防止内容相同但路径不同被混淆
    for (let i = 0; i < path.length; i++) {
      hash = ((hash << 5) + hash + path.charCodeAt(i)) & 0xFFFFFFFF;
    }
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

// ========== Audit Log Management ==========

const AUDIT_LOG_KEY = "codem-skill-audit-log";
const MAX_LOG_ENTRIES = 200;

/**
 * 获取安装审计日志。
 */
export function getInstallAuditLog(): InstallAuditEntry[] {
  return getSettingJSON<InstallAuditEntry[]>(AUDIT_LOG_KEY, []);
}

/**
 * 添加安装审计条目。
 */
export function addInstallAuditEntry(entry: InstallAuditEntry): void {
  const log = getInstallAuditLog();
  log.unshift(entry); // 最新的在前面
  // 限制日志大小
  if (log.length > MAX_LOG_ENTRIES) {
    log.length = MAX_LOG_ENTRIES;
  }
  setSettingJSON(AUDIT_LOG_KEY, log);
}

/**
 * 清除安装审计日志。
 */
export function clearInstallAuditLog(): void {
  setSettingJSON(AUDIT_LOG_KEY, []);
}

// ========== SKILL.md Permission Validation ==========

/** 已知安全权限列表 */
const KNOWN_PERMISSIONS = new Set([
  "file:read", "file:write", "file:delete",
  "command:exec", "command:read",
  "network:fetch", "network:websocket",
  "mcp:call", "mcp:list",
  "skill:load", "skill:list",
  "memory:read", "memory:write",
  "context:read", "context:write",
  "project:read", "project:write",
  "git:read", "git:write",
  "terminal:exec",
  "browser:navigate", "browser:scrape",
  "knowledge:read", "knowledge:write",
  "notebook:read", "notebook:write",
]);

/**
 * 验证技能声明的权限是否在已知列表中。
 * 返回未知的权限列表（可能是自定义权限，需用户注意）。
 */
export function validatePermissions(permissions: string[]): string[] {
  const unknown: string[] = [];
  for (const perm of permissions) {
    if (!KNOWN_PERMISSIONS.has(perm)) {
      unknown.push(perm);
    }
  }
  return unknown;
}

/**
 * 获取权限的友好描述。
 */
export function getPermissionDescription(perm: string, lang: "zh" | "en" = "zh"): string {
  const descriptions: Record<string, { zh: string; en: string }> = {
    "file:read": { zh: "读取文件", en: "Read files" },
    "file:write": { zh: "写入文件", en: "Write files" },
    "file:delete": { zh: "删除文件", en: "Delete files" },
    "command:exec": { zh: "执行命令", en: "Execute commands" },
    "command:read": { zh: "读取命令输出", en: "Read command output" },
    "network:fetch": { zh: "发起网络请求", en: "Make network requests" },
    "network:websocket": { zh: "建立 WebSocket 连接", en: "Establish WebSocket connections" },
    "mcp:call": { zh: "调用 MCP 工具", en: "Call MCP tools" },
    "mcp:list": { zh: "列出 MCP 工具", en: "List MCP tools" },
    "skill:load": { zh: "加载其他技能", en: "Load other skills" },
    "skill:list": { zh: "列出已安装技能", en: "List installed skills" },
    "memory:read": { zh: "读取记忆", en: "Read memory" },
    "memory:write": { zh: "写入记忆", en: "Write memory" },
    "context:read": { zh: "读取上下文", en: "Read context" },
    "context:write": { zh: "写入上下文", en: "Write context" },
    "project:read": { zh: "读取项目信息", en: "Read project info" },
    "project:write": { zh: "修改项目设置", en: "Modify project settings" },
    "git:read": { zh: "读取 Git 状态", en: "Read Git status" },
    "git:write": { zh: "执行 Git 操作", en: "Execute Git operations" },
    "terminal:exec": { zh: "执行终端命令", en: "Execute terminal commands" },
    "browser:navigate": { zh: "浏览器导航", en: "Browser navigation" },
    "browser:scrape": { zh: "浏览器抓取", en: "Browser scraping" },
    "knowledge:read": { zh: "读取知识库", en: "Read knowledge base" },
    "knowledge:write": { zh: "写入知识库", en: "Write knowledge base" },
    "notebook:read": { zh: "读取笔记", en: "Read notebooks" },
    "notebook:write": { zh: "写入笔记", en: "Write notebooks" },
  };
  return descriptions[perm]?.[lang] || perm;
}
