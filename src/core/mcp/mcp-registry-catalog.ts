/**
 * MCP Server Registry Catalog — 预设 MCP 服务器目录。
 *
 * 提供可搜索的 MCP 服务器列表，用户可一键安装到 MCPRegistry。
 * 数据来源：本地硬编码的流行 MCP 服务器列表 + 在线 GitHub 仓库索引。
 *
 * IP 声明：本文件所有代码均为原创实现，仅引用公开的 MCP 服务器包名。
 */

import type { MCPServerConfig } from "./mcp";
import { getMCPRegistry } from "./mcp";

// ========== Types ==========

/** MCP 服务器目录条目 */
export interface MCPRegistryEntry {
  /** 唯一 ID */
  id: string;
  /** 显示名称 */
  name: string;
  /** 描述 */
  description: string;
  /** 作者/维护者 */
  author: string;
  /** 分类标签 */
  category: MCPCategory;
  /** 标签 */
  tags?: string[];
  /** 传输方式 */
  transport: "stdio" | "http" | "sse";
  /** 安装命令（stdio 类型）*/
  command?: string;
  /** 安装参数（stdio 类型）*/
  args?: string[];
  /** 环境变量 */
  env?: Record<string, string>;
  /** URL（http/sse 类型）*/
  url?: string;
  /** 图标 emoji */
  icon?: string;
  /** 官方文档/主页 URL */
  homepage?: string;
  /** 是否需要 API Key（env 中的 key 名称）*/
  requiresApiKey?: string;
  /** 默认超时 */
  timeout?: number;
}

/** MCP 分类 */
export type MCPCategory =
  | "filesystem"
  | "database"
  | "search"
  | "developer-tools"
  | "communication"
  | "productivity"
  | "data"
  | "cloud"
  | "other";

// ========== Preset Registry ==========

/** 预设 MCP 服务器列表 */
export const MCP_CATALOG: MCPRegistryEntry[] = [
  // === Filesystem ===
  {
    id: "filesystem",
    name: "Filesystem",
    description: "提供文件系统读写操作能力，包括读取文件、写入文件、创建目录、搜索文件等。",
    author: "Anthropic",
    category: "filesystem",
    tags: ["files", "io", "read", "write"],
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem"],
    icon: "📁",
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
  },
  {
    id: "git",
    name: "Git",
    description: "Git 版本控制操作：提交、推送、拉取、分支管理、查看日志等。",
    author: "Anthropic",
    category: "developer-tools",
    tags: ["git", "vcs", "version-control"],
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-git"],
    icon: "🔀",
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/git",
  },

  // === Database ===
  {
    id: "sqlite",
    name: "SQLite",
    description: "SQLite 数据库操作：查询、插入、更新、删除、schema 查看。",
    author: "Anthropic",
    category: "database",
    tags: ["sqlite", "sql", "database"],
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-sqlite"],
    icon: "🗄️",
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/sqlite",
  },
  {
    id: "postgres",
    name: "PostgreSQL",
    description: "PostgreSQL 数据库只读查询和 schema 探索。",
    author: "Anthropic",
    category: "database",
    tags: ["postgres", "sql", "database"],
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-postgres"],
    icon: "🐘",
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/postgres",
    requiresApiKey: "DATABASE_URL",
  },

  // === Search ===
  {
    id: "brave-search",
    name: "Brave Search",
    description: "Brave 搜索引擎集成：网页搜索、图片搜索、新闻搜索。",
    author: "Anthropic",
    category: "search",
    tags: ["search", "web", "brave"],
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-brave-search"],
    icon: "🦁",
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/brave-search",
    requiresApiKey: "BRAVE_API_KEY",
  },
  {
    id: "fetch",
    name: "Fetch",
    description: "URL 内容获取和解析：将网页内容转换为 Markdown 格式供 LLM 使用。",
    author: "Anthropic",
    category: "data",
    tags: ["fetch", "http", "web", "markdown"],
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-fetch"],
    icon: "🌐",
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch",
  },

  // === Developer Tools ===
  {
    id: "github",
    name: "GitHub",
    description: "GitHub API 集成：仓库管理、Issue/PR 操作、代码搜索、Gist 管理。",
    author: "Anthropic",
    category: "developer-tools",
    tags: ["github", "api", "issues", "pr"],
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    icon: "🐙",
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/github",
    requiresApiKey: "GITHUB_PERSONAL_ACCESS_TOKEN",
  },
  {
    id: "sequential-thinking",
    name: "Sequential Thinking",
    description: "结构化思维工具：分步推理、思维链追踪、动态问题分解。",
    author: "Anthropic",
    category: "productivity",
    tags: ["thinking", "reasoning", "planning"],
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
    icon: "🧠",
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking",
  },
  {
    id: "memory",
    name: "Memory",
    description: "持久化记忆层：基于知识图谱存储实体和关系，支持跨会话记忆。",
    author: "Anthropic",
    category: "productivity",
    tags: ["memory", "knowledge-graph", "persistence"],
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-memory"],
    icon: "💾",
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/memory",
  },

  // === Cloud ===
  {
    id: "google-drive",
    name: "Google Drive",
    description: "Google Drive 文件操作：搜索、读取、创建文档和表格。",
    author: "Anthropic",
    category: "cloud",
    tags: ["google", "drive", "cloud", "files"],
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-google-drive"],
    icon: "📁",
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/gdrive",
    requiresApiKey: "GOOGLE_CLIENT_ID",
  },
  {
    id: "google-maps",
    name: "Google Maps",
    description: "Google Maps API：地址搜索、路线规划、距离计算、地点详情。",
    author: "Anthropic",
    category: "data",
    tags: ["google", "maps", "location", "directions"],
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-google-maps"],
    icon: "🗺️",
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/google-maps",
    requiresApiKey: "GOOGLE_MAPS_API_KEY",
  },

  // === Communication ===
  {
    id: "slack",
    name: "Slack",
    description: "Slack 工作空间集成：频道消息发送、搜索、用户列表。",
    author: "Anthropic",
    category: "communication",
    tags: ["slack", "messaging", "chat"],
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-slack"],
    icon: "💬",
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/slack",
    requiresApiKey: "SLACK_BOT_TOKEN",
  },

  // === Data ===
  {
    id: "puppeteer",
    name: "Puppeteer",
    description: "浏览器自动化：网页导航、截图、PDF 生成、DOM 交互。",
    author: "Anthropic",
    category: "data",
    tags: ["puppeteer", "browser", "automation", "scraping"],
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-puppeteer"],
    icon: "🎭",
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/puppeteer",
  },
  {
    id: "everart",
    name: "EverArt",
    description: "AI 图像生成：通过 EverArt API 生成图片。",
    author: "Anthropic",
    category: "other",
    tags: ["image", "ai", "generation"],
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-everart"],
    icon: "🎨",
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/everart",
    requiresApiKey: "EVERART_API_KEY",
  },

  // === Community MCPs ===
  {
    id: "time",
    name: "Time",
    description: "时间工具：获取当前时间、时区转换、时间格式化。",
    author: "Community",
    category: "productivity",
    tags: ["time", "timezone", "date"],
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-time"],
    icon: "⏰",
    homepage: "https://github.com/modelcontextprotocol/servers",
  },
  {
    id: "everything",
    name: "Everything (Demo)",
    description: "MCP 测试服务器：提供各种工具调用的演示接口，用于开发和测试。",
    author: "Community",
    category: "other",
    tags: ["demo", "test", "development"],
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-everything"],
    icon: "🧪",
    homepage: "https://github.com/modelcontextprotocol/servers",
  },

  // === HTTP/SSE 类型 ===
  {
    id: "sentry",
    name: "Sentry",
    description: "Sentry 错误追踪集成：查看错误、堆栈跟踪、release 信息。",
    author: "Community",
    category: "developer-tools",
    tags: ["sentry", "error-tracking", "monitoring"],
    transport: "http",
    url: "https://mcp.sentry.dev/sse",
    icon: "🔍",
    homepage: "https://docs.sentry.io/product/integrations/mcp/",
  },
];

// ========== Category Labels ==========

export const CATEGORY_LABELS: Record<MCPCategory, { zh: string; en: string; icon: string }> = {
  filesystem: { zh: "文件系统", en: "Filesystem", icon: "📁" },
  database: { zh: "数据库", en: "Database", icon: "🗄️" },
  search: { zh: "搜索", en: "Search", icon: "🔍" },
  "developer-tools": { zh: "开发工具", en: "Developer Tools", icon: "🛠️" },
  communication: { zh: "通信", en: "Communication", icon: "💬" },
  productivity: { zh: "效率", en: "Productivity", icon: "⚡" },
  data: { zh: "数据", en: "Data", icon: "📊" },
  cloud: { zh: "云服务", en: "Cloud", icon: "☁️" },
  other: { zh: "其他", en: "Other", icon: "📦" },
};

// ========== Catalog API ==========

/** 获取所有目录条目 */
export function getCatalog(): MCPRegistryEntry[] {
  return [...MCP_CATALOG];
}

/** 按分类获取 */
export function getByCategory(category: MCPCategory): MCPRegistryEntry[] {
  return MCP_CATALOG.filter((e) => e.category === category);
}

/** 搜索目录 */
export function searchCatalog(query: string): MCPRegistryEntry[] {
  const q = query.toLowerCase().trim();
  if (!q) return getCatalog();
  return MCP_CATALOG.filter((e) => {
    const haystack = [
      e.name, e.description, e.author,
      ...(e.tags || []),
      e.category,
    ].join(" ").toLowerCase();
    return haystack.includes(q);
  });
}

/** 获取所有分类 */
export function getCategories(): MCPCategory[] {
  const cats = new Set(MCP_CATALOG.map((e) => e.category));
  return Array.from(cats).sort();
}

/** 检查目录条目是否已安装 */
export function isEntryInstalled(entry: MCPRegistryEntry): boolean {
  const registry = getMCPRegistry();
  const configs = registry.getConfigs();
  return configs.some((c) => c.name === entry.id || c.name === entry.name);
}

/** 获取已安装条目的名称列表 */
export function getInstalledEntryNames(): Set<string> {
  const registry = getMCPRegistry();
  const configs = registry.getConfigs();
  return new Set(configs.map((c) => c.name));
}

/**
 * 将目录条目转换为 MCPServerConfig 并安装到 MCPRegistry。
 * @param entry 目录条目
 * @param envOverrides 环境变量覆盖（如 API Key）
 * @returns 安装结果
 */
export function installCatalogEntry(
  entry: MCPRegistryEntry,
  envOverrides?: Record<string, string>,
): { success: boolean; error?: string } {
  const registry = getMCPRegistry();

  // 检查是否已安装
  const existing = registry.getConfigs().find(
    (c) => c.name === entry.id || c.name === entry.name
  );
  if (existing) {
    return { success: false, error: `服务器 "${entry.name}" 已存在` };
  }

  // 构建 MCPServerConfig
  const config: MCPServerConfig = {
    name: entry.id,
    transport: entry.transport,
    command: entry.command,
    args: entry.args,
    env: { ...entry.env, ...envOverrides },
    url: entry.url,
    timeout: entry.timeout || 10000,
    autoReconnect: true,
  };

  // 验证
  if (config.transport === "stdio" && !config.command) {
    return { success: false, error: "stdio 类型服务器需要 command" };
  }
  if ((config.transport === "http" || config.transport === "sse") && !config.url) {
    return { success: false, error: "http/sse 类型服务器需要 url" };
  }

  registry.addServer(config);
  return { success: true };
}

/**
 * 卸载目录条目。
 */
export function uninstallCatalogEntry(entry: MCPRegistryEntry): { success: boolean; error?: string } {
  const registry = getMCPRegistry();
  const name = registry.getConfigs().find(
    (c) => c.name === entry.id || c.name === entry.name
  )?.name;

  if (!name) {
    return { success: false, error: `服务器 "${entry.name}" 未安装` };
  }

  registry.removeServer(name);
  return { success: true };
}
