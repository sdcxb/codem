/**
 * SkillMarketClient — 技能市场客户端。
 *
 * 架构方案 B+C：通过 Tauri Rust 层的 http_get / http_download 命令代理 HTTP 请求，
 * 绕过前端 CSP 限制，无需额外运行时依赖。
 *
 * 支持的市场源类型：
 * 1. github-repo    — GitHub 仓库目录型（如 anthropics/skills，每个子目录是一个技能）
 * 2. github-search   — GitHub 话题搜索型（搜索 topic:agent-skills 的仓库）
 * 3. builtin         — 内置技能展示型（展示 Codem 自带技能，无需下载）
 * 4. clawhub-api     — ClawHub.ai REST API（GET /api/v1/skills）
 * 5. skills-sh-api   — Skills.sh REST API（GET /api/v1/skills + /api/v1/skills/search）
 * 6. cli             — CLI 子进程型（如 skillhub-cli，通过 executeCommand 调用）
 *
 * IP 声明：本文件所有代码均为原创实现，仅使用公开 REST API 和 CLI 工具。
 */

import { installSkillFromZip, type InstallResult, type InstallProgressCallback } from "./installer";
import { getSkillRegistry, parseSkillMarkdown, type SkillDefinition } from "./skill";
import { writeFile, readFile, deletePath } from "../file-api";
import { getSettingJSON, setSettingJSON } from "../storage/settings";
// P3-27: 增强安全沙箱
import {
  auditSkillInstallation,
  computeContentHash,
  addInstallAuditEntry,
  type SkillAuditResult,
} from "./sandbox";

// ========== Types ==========

/** 市场源类型 */
export type MarketSourceType =
  | "github-repo"
  | "github-search"
  | "builtin"
  | "clawhub-api"
  | "skills-sh-api"
  | "skillhub-api"
  | "cli";

/** 市场源配置 */
export interface MarketSource {
  id: string;
  name: string;
  type: MarketSourceType;
  /** API URL、搜索查询或 CLI 命令前缀 */
  url: string;
  /** 是否启用 */
  enabled: boolean;
  /** 图标 emoji（用于 UI 展示） */
  icon?: string;
  /** 子目录路径（仅 github-repo 类型）。如果仓库技能不在根目录而在子目录中，指定该子目录名。 */
  subdir?: string;
  /**
   * CLI 命令名（仅 type=cli）。
   * 如 "skillhub" 表示使用 skillhub-cli，实际调用 skillhub search / skillhub install。
   */
  cliCommand?: string;
  /**
   * API Token（仅 clawhub-api / skills-sh-api）。
   * Skills.sh 需要 Vercel OIDC Token 认证；ClawHub 可选。
   * skillhub-api 类型无需认证，直接使用公开 REST API。
   */
  apiToken?: string;
}

/** 市场技能条目 */
export interface MarketSkill {
  /** 唯一 ID（source-id + skill-path） */
  id: string;
  /** 技能名称 */
  name: string;
  /** 显示名称 */
  displayName: string;
  /** 描述 */
  description: string;
  /** 作者 */
  author?: string;
  /** 版本 */
  version?: string;
  /** 标签 */
  tags?: string[];
  /** 来源市场 */
  sourceId: string;
  /** 来源市场名称 */
  sourceName: string;
  /** 下载 URL（ZIP 包或 raw 文件） */
  downloadUrl: string;
  /** 仓库主页 URL */
  repoUrl?: string;
  /** Star 数（GitHub 搜索结果） */
  stars?: number;
  /** 最后更新时间 */
  lastUpdated?: string;
  /** 是否已安装 */
  installed?: boolean;
  /** 安装类型：zip（整个仓库 ZIP）或 dir（仓库内子目录） */
  installType: "zip" | "dir" | "builtin";
  /** 如果是 dir 类型，指定仓库内目录路径 */
  dirPath?: string;
  /** 仓库 owner/repo（用于 GitHub API） */
  repoFullName?: string;
  /** 默认分支 */
  branch?: string;
}

/** HTTP 响应（对应 Rust HttpResponse） */
interface HttpResponse {
  status: number;
  body: string;
  headers: Record<string, string>;
}

// ========== Default Market Sources ==========

/** 默认市场源列表 */
export const DEFAULT_MARKET_SOURCES: MarketSource[] = [
  {
    id: "anthropic-skills",
    name: "Anthropic Skills",
    type: "github-repo",
    url: "https://api.github.com/repos/anthropics/skills",
    enabled: true,
    icon: "🧠",
    subdir: "skills",
  },
  {
    id: "github-agent-skills",
    name: "GitHub Agent Skills",
    type: "github-search",
    url: "https://api.github.com/search/repositories?q=topic:agent-skills+topic:ai-coding&sort=stars&order=desc&per_page=30",
    enabled: true,
    icon: "⭐",
  },
  {
    id: "github-skill-md",
    name: "GitHub SKILL.md Repos",
    type: "github-search",
    url: "https://api.github.com/search/repositories?q=SKILL.md+in:name,description&sort=stars&order=desc&per_page=20",
    enabled: true,
    icon: "📦",
  },
  {
    id: "clawhub",
    name: "ClawHub.ai",
    type: "clawhub-api",
    url: "https://clawhub.ai",
    enabled: true,
    icon: "🦞",
  },
  {
    id: "skills-sh",
    name: "Skills.sh",
    type: "skills-sh-api",
    url: "https://skills.sh",
    enabled: true,
    icon: "🎯",
  },
  {
    id: "skillhub",
    name: "SkillHub",
    type: "skillhub-api",
    url: "https://skills.palebluedot.live",
    enabled: true,
    icon: "☁️",
  },
  {
    id: "codem-builtin",
    name: "Codem 内置技能",
    type: "builtin",
    url: "",
    enabled: true,
    icon: "⚡",
  },
];

// ========== Settings ==========

const MARKET_SOURCES_KEY = "codem-market-sources";

/** 获取市场源列表（合并默认源和用户配置） */
export function getMarketSources(): MarketSource[] {
  const saved = getSettingJSON<MarketSource[]>(MARKET_SOURCES_KEY, []);
  if (saved.length === 0) {
    return DEFAULT_MARKET_SOURCES;
  }
  // 合并：以 saved 为主，但用 defaults 中的新字段（如 subdir）补充
  return saved.map((s) => {
    const def = DEFAULT_MARKET_SOURCES.find((d) => d.id === s.id);
    if (def) {
      return { ...def, ...s, subdir: s.subdir ?? def.subdir };
    }
    return s;
  });
}

/** 保存市场源列表 */
export function setMarketSources(sources: MarketSource[]): void {
  setSettingJSON(MARKET_SOURCES_KEY, sources);
}

// ========== Tauri Invoke Helpers ==========

async function tauriInvoke(command: string, args?: Record<string, unknown>): Promise<any> {
  const { invoke } = (window as any).__TAURI__?.core || {};
  if (!invoke) {
    throw new Error("Tauri invoke not available — skill market requires Tauri runtime.");
  }
  return invoke(command, args);
}

/** 通过 Rust 层发起 HTTP GET 请求（绕过 CSP） */
async function httpGet(url: string, headers?: Record<string, string>): Promise<HttpResponse> {
  return tauriInvoke("http_get", { url, headers });
}

/** 通过 Rust 层下载文件到本地路径 */
async function httpDownload(url: string, destPath: string, headers?: Record<string, string>): Promise<string> {
  return tauriInvoke("http_download", { url, destPath, headers });
}

// ========== GitHub API Helpers ==========

/** GitHub API 请求头（包含 Accept header 用于获取 JSON） */
function githubApiHeaders(): Record<string, string> {
  return {
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/** 获取仓库默认分支 */
async function getDefaultBranch(repoFullName: string): Promise<string> {
  const resp = await httpGet(
    `https://api.github.com/repos/${repoFullName}`,
    githubApiHeaders(),
  );
  if (resp.status !== 200) return "main";
  const data = JSON.parse(resp.body);
  return data.default_branch || "main";
}

// ========== Source Adapters ==========

/**
 * 从 GitHub 仓库目录型源获取技能列表。
 * 仓库根目录下的每个子目录被视为一个技能。
 */
async function fetchGitHubRepoSkills(source: MarketSource): Promise<MarketSkill[]> {
  const skills: MarketSkill[] = [];

  try {
    // 获取仓库信息
    const repoResp = await httpGet(source.url, githubApiHeaders());
    if (repoResp.status !== 200) {
      console.warn(`[SkillMarket] Failed to fetch repo info for ${source.id}: ${repoResp.status}`);
      return skills;
    }
    const repoInfo = JSON.parse(repoResp.body);
    const defaultBranch = repoInfo.default_branch || "main";
    const repoFullName = repoInfo.full_name;

    // 获取目录内容：如果有 subdir 则从子目录获取，否则从根目录获取
    const contentsPath = source.subdir
      ? `https://api.github.com/repos/${repoFullName}/contents/${source.subdir}?ref=${defaultBranch}`
      : `https://api.github.com/repos/${repoFullName}/contents/?ref=${defaultBranch}`;
    const contentsResp = await httpGet(contentsPath, githubApiHeaders());
    if (contentsResp.status !== 200) {
      console.warn(`[SkillMarket] Failed to fetch repo contents for ${source.id}: ${contentsResp.status}`);
      return skills;
    }
    const rootContents = JSON.parse(contentsResp.body);
    if (!Array.isArray(rootContents)) return skills;

    // 筛选目录
    const dirs = rootContents.filter((item: any) => item.type === "dir");

    // 获取每个目录的 SKILL.md
    // 如果有 subdir，SKILL.md 路径为 {subdir}/{dir.name}/SKILL.md
    const skillMdBase = source.subdir
      ? `https://raw.githubusercontent.com/${repoFullName}/${defaultBranch}/${source.subdir}`
      : `https://raw.githubusercontent.com/${repoFullName}/${defaultBranch}`;

    for (const dir of dirs) {
      try {
        const skillMdUrl = `${skillMdBase}/${dir.name}/SKILL.md`;
        const mdResp = await httpGet(skillMdUrl);
        if (mdResp.status !== 200) continue;

        // 传入路径用于 fallback 命名
        const skillPath = source.subdir
          ? `${source.subdir}/${dir.name}/SKILL.md`
          : `${dir.name}/SKILL.md`;
        const skillDef = parseSkillMarkdown(mdResp.body, skillPath);
        if (!skillDef) continue;

        skills.push({
          id: `${source.id}:${dir.name}`,
          name: skillDef.name || dir.name,
          displayName: skillDef.displayName || skillDef.name || dir.name,
          description: skillDef.description || "",
          author: skillDef.author || repoFullName.split("/")[0],
          version: skillDef.version,
          tags: skillDef.tags,
          sourceId: source.id,
          sourceName: source.name,
          downloadUrl: `https://api.github.com/repos/${repoFullName}/zipball/${defaultBranch}`,
          repoUrl: dir.html_url || `https://github.com/${repoFullName}/tree/${defaultBranch}/${source.subdir ? source.subdir + "/" : ""}${dir.name}`,
          lastUpdated: repoInfo.updated_at,
          installType: "dir",
          dirPath: source.subdir ? `${source.subdir}/${dir.name}` : dir.name,
          repoFullName,
          branch: defaultBranch,
        });
      } catch (err) {
        console.warn(`[SkillMarket] Failed to fetch skill metadata for ${dir.name}:`, err);
      }
    }
  } catch (err) {
    console.error(`[SkillMarket] Error fetching repo skills for ${source.id}:`, err);
  }

  return skills;
}

/**
 * 从 GitHub 搜索型源获取技能列表。
 * 搜索结果中的每个仓库被视为一个技能。
 */
async function fetchGitHubSearchSkills(source: MarketSource): Promise<MarketSkill[]> {
  const skills: MarketSkill[] = [];

  try {
    const resp = await httpGet(source.url, githubApiHeaders());
    if (resp.status !== 200) {
      console.warn(`[SkillMarket] GitHub search failed for ${source.id}: ${resp.status}`);
      // Handle rate limit
      if (resp.status === 403 && resp.headers["x-ratelimit-remaining"] === "0") {
        console.warn(`[SkillMarket] GitHub API rate limit exceeded for ${source.id}`);
      }
      return skills;
    }

    const data = JSON.parse(resp.body);
    if (!data.items || !Array.isArray(data.items)) return skills;

    // 并行获取每个仓库的 SKILL.md（之前是串行，30 个仓库需要 60+ 个请求）
    const repoSkills = await Promise.allSettled(
      data.items.map(async (repo: any) => {
        let description = repo.description || "";
        let displayName = repo.name;
        let author = repo.owner?.login || "";
        let tags: string[] | undefined;
        let version: string | undefined;

        try {
          const branch = repo.default_branch || "main";
          const skillMdUrl = `https://raw.githubusercontent.com/${repo.full_name}/${branch}/SKILL.md`;
          const mdResp = await httpGet(skillMdUrl);
          if (mdResp.status === 200) {
            const skillDef = parseSkillMarkdown(mdResp.body, "");
            if (skillDef) {
              displayName = skillDef.displayName || skillDef.name || displayName;
              description = skillDef.description || description;
              author = skillDef.author || author;
              version = skillDef.version;
              tags = skillDef.tags;
            }
          }
        } catch {
          // SKILL.md not found — use repo metadata only
        }

        return {
          id: `${source.id}:${repo.full_name}`,
          name: repo.name,
          displayName,
          description: description || "无描述",
          author,
          version,
          tags: Array.isArray(tags) ? tags : (Array.isArray(repo.topics) ? repo.topics : []),
          sourceId: source.id,
          sourceName: source.name,
          downloadUrl: `https://api.github.com/repos/${repo.full_name}/zipball/${repo.default_branch || "main"}`,
          repoUrl: repo.html_url,
          stars: repo.stargazers_count,
          lastUpdated: repo.updated_at,
          installType: "zip" as const,
          repoFullName: repo.full_name,
          branch: repo.default_branch || "main",
        };
      }),
    );

    for (const result of repoSkills) {
      if (result.status === "fulfilled") {
        skills.push(result.value);
      }
    }
  } catch (err) {
    console.error(`[SkillMarket] Error fetching search skills for ${source.id}:`, err);
  }

  return skills;
}

/**
 * 获取内置技能列表作为市场条目。
 */
async function fetchBuiltinSkills(source: MarketSource): Promise<MarketSkill[]> {
  const registry = getSkillRegistry();
  const allSkills = registry.getAll();
  return allSkills
    .filter((s) => s.source === "builtin")
    .map((s) => ({
      id: `${source.id}:${s.name}`,
      name: s.name,
      displayName: s.displayName || s.name,
      description: s.description,
      author: s.author || "Codem",
      version: s.version,
      tags: s.tags,
      sourceId: source.id,
      sourceName: source.name,
      downloadUrl: "",
      installType: "builtin" as const,
      installed: true,
    }));
}

// ========== ClawHub.ai API Adapter ==========

/**
 * 从 ClawHub.ai REST API 获取技能列表。
 *
 * ClawHub 是 OpenClaw 生态的技能市场，提供 REST API：
 *   GET /api/v1/skills?limit=&cursor=&sort= → 技能列表（游标分页）
 *
 * 响应格式：
 *   { data: [{ name, slug, description, author, downloads, ... }], nextCursor: "..." }
 *
 * API 文档：https://docs.openclaw.ai/clawhub/api
 * 公共读取无需认证，IP 级限流 3000/min。
 */
async function fetchClawHubSkills(source: MarketSource): Promise<MarketSkill[]> {
  const skills: MarketSkill[] = [];
  const MAX_PAGES = 3; // 最多 3 页 × 100 条/页 = 300 条（避免多页串行请求导致加载慢）
  const PAGE_SIZE = 100;
  let pageNum = 0;

  try {
    const baseUrl = source.url.replace(/\/$/, "");
    const headers: Record<string, string> = {
      "Accept": "application/json",
    };
    if (source.apiToken) {
      headers["Authorization"] = `Bearer ${source.apiToken}`;
    }

    let cursor: string | null = null;

    while (pageNum < MAX_PAGES) {
      // 构建带分页参数的 URL
      const params = new URLSearchParams();
      params.set("limit", String(PAGE_SIZE));
      params.set("sort", "downloads");
      if (cursor) {
        params.set("cursor", cursor);
      }

      const resp = await httpGet(`${baseUrl}/api/v1/skills?${params.toString()}`, headers);
      if (resp.status !== 200) {
        console.warn(`[SkillMarket] ClawHub API failed (page ${pageNum}): ${resp.status}`);
        break;
      }

      const data = JSON.parse(resp.body);
      // 兼容多种响应格式
      const items: any[] = data.data || data.items || data.skills || [];
      if (items.length === 0) break;

      for (const item of items) {
        const slug = item.slug || item.name;
        if (!slug) continue;
        const author = item.author || item.owner || "";
        skills.push({
          id: `${source.id}:${slug}`,
          name: slug,
          displayName: item.displayName || item.name || slug,
          description: item.description || "无描述",
          author,
          version: item.version,
          tags: Array.isArray(item.tags) ? item.tags : [],
          sourceId: source.id,
          sourceName: source.name,
          downloadUrl: item.installUrl || item.downloadUrl || (item.repoFullName ? `https://api.github.com/repos/${item.repoFullName}/zipball/main` : `${baseUrl}/${author}/skills/${slug}`),
          repoUrl: item.url || `${baseUrl}/${author}/skills/${slug}`,
          stars: item.downloads || item.installs,
          lastUpdated: item.updatedAt,
          installType: "zip",
          repoFullName: item.repoFullName,
          branch: item.branch || "main",
        });
      }

      // 检查是否有下一页游标
      cursor = data.nextCursor || data.cursor || data.next_cursor || null;
      if (!cursor) break;
      pageNum++;
    }
  } catch (err) {
    console.error(`[SkillMarket] Error fetching ClawHub skills:`, err);
  }

  console.log(`[SkillMarket] ClawHub: fetched ${skills.length} skills across ${pageNum + 1} page(s)`);
  return skills;
}

// ========== Skills.sh API Adapter ==========

/**
 * 从 Skills.sh 获取技能列表。
 *
 * Skills.sh 由 Vercel 运营，提供 REST API：
 *   GET /api/v1/skills?view=all-time&page=0&per_page=100 → 分页排行榜
 *
 * 认证：Vercel OIDC Token（桌面应用无法获取）。
 * 策略：
 *   1. 先尝试 API 无认证请求（部分端点可能允许匿名访问）
 *   2. 若 401，fallback 到网页版 HTML 爬取（解析排行榜页面中的技能数据）
 *   3. 网页版支持多视图：all-time / trending / hot
 *
 * API 文档：https://skills.sh/docs/api
 */
async function fetchSkillsShSkills(source: MarketSource): Promise<MarketSkill[]> {
  const baseUrl = source.url.replace(/\/$/, "");

  // 策略 1：尝试 API 无认证请求
  const apiSkills = await fetchSkillsShViaAPI(source, baseUrl);
  if (apiSkills.length > 0) {
    return apiSkills;
  }

  // 策略 2：fallback 到网页版 HTML 爬取
  console.log("[SkillMarket] Skills.sh API failed or returned 0, falling back to HTML scrape");
  return await fetchSkillsShViaHTML(source, baseUrl);
}

/**
 * 通过 Skills.sh REST API 获取技能（带分页）。
 * API 可能需要 Vercel OIDC 认证，尝试无认证请求。
 */
async function fetchSkillsShViaAPI(source: MarketSource, baseUrl: string): Promise<MarketSkill[]> {
  const skills: MarketSkill[] = [];
  const MAX_PAGES = 2; // 最多 2 页 × 500 条/页 = 1000 条（避免多页串行请求导致加载慢）
  const PER_PAGE = 500;

  try {
    const headers: Record<string, string> = {
      "Accept": "application/json",
    };
    if (source.apiToken) {
      headers["Authorization"] = `Bearer ${source.apiToken}`;
    }

    let page = 0;
    let hasMore = true;

    while (hasMore && page < MAX_PAGES) {
      const resp = await httpGet(
        `${baseUrl}/api/v1/skills?view=all-time&page=${page}&per_page=${PER_PAGE}`,
        headers,
      );
      if (resp.status === 401) {
        console.warn("[SkillMarket] Skills.sh API requires Vercel OIDC token authentication");
        return skills; // 返回已获取的（可能为空）
      }
      if (resp.status !== 200) {
        console.warn(`[SkillMarket] Skills.sh API failed (page ${page}): ${resp.status}`);
        return skills;
      }

      const data = JSON.parse(resp.body);
      const items: any[] = data.data || [];
      if (items.length === 0) break;

      for (const item of items) {
        const skillId = item.id || `${item.source}/${item.slug}`;
        skills.push({
          id: `${source.id}:${skillId}`,
          name: item.slug || item.name,
          displayName: item.name || item.slug,
          description: item.description || "无描述",
          author: item.source || "",
          version: item.version,
          tags: Array.isArray(item.tags) ? item.tags : [],
          sourceId: source.id,
          sourceName: source.name,
          downloadUrl: item.installUrl || (item.source ? `https://api.github.com/repos/${item.source}/zipball/main` : ""),
          repoUrl: item.url || `${baseUrl}/${skillId}`,
          stars: item.installs,
          lastUpdated: item.updatedAt,
          installType: item.source ? "dir" : "zip",
          repoFullName: item.source,
          dirPath: item.slug || item.name,
        });
      }

      // 检查分页信息
      const pagination = data.pagination;
      hasMore = pagination ? pagination.hasMore === true : false;
      page++;
    }

    console.log(`[SkillMarket] Skills.sh API: fetched ${skills.length} skills across ${page} page(s)`);
  } catch (err) {
    console.error(`[SkillMarket] Error fetching Skills.sh via API:`, err);
  }

  return skills;
}

/**
 * 通过爬取 Skills.sh 网页版 HTML 获取技能列表。
 *
 * Skills.sh 网站服务端渲染了排行榜数据，HTML 中包含技能名、来源、安装数等信息。
 * 解析 HTML 中的技能链接和文本内容。
 */
async function fetchSkillsShViaHTML(source: MarketSource, baseUrl: string): Promise<MarketSkill[]> {
  const skills: MarketSkill[] = [];

  try {
    // 爬取多个视图页面
    const views = [
      { path: "", label: "all-time" },
      { path: "/trending", label: "trending" },
      { path: "/hot", label: "hot" },
    ];

    const seenSlugs = new Set<string>();

    for (const view of views) {
      try {
        const resp = await httpGet(`${baseUrl}${view.path}`, {
          "Accept": "text/html",
        });
        if (resp.status !== 200) {
          console.warn(`[SkillMarket] Skills.sh HTML scrape failed for ${view.label}: ${resp.status}`);
          continue;
        }

        const html = resp.body;

        // Skills.sh 页面中技能链接格式：/vercel-labs/skills/find-skills
        // 匹配所有技能详情页链接 — 只匹配字母数字和连字符组成的路径段
        const skillLinkPattern = /href="\/([a-zA-Z0-9][\w.-]*\/[a-zA-Z0-9][\w.-]*)\/([a-zA-Z0-9][\w.-]*)"/g;
        let match: RegExpExecArray | null;

        while ((match = skillLinkPattern.exec(html)) !== null) {
          const source_path = match[1]; // e.g., "vercel-labs/skills"
          const slug = match[2]; // e.g., "find-skills"

          // 过滤非技能链接（如 /agent/xxx, /topic/xxx, /docs 等）
          if (source_path.startsWith("agent/") ||
              source_path.startsWith("topic/") ||
              source_path.startsWith("docs") ||
              source_path === "packs" ||
              slug === "official" ||
              slug === "audits") {
            continue;
          }

          // 清洗 source_path：去除可能残留的 HTML 标签和属性
          // 正则可能匹配到 href 值中包含的额外 HTML 属性（如 link rel=...）
          const cleanSourcePath = source_path.replace(/[^a-zA-Z0-9._\-\/]/g, "");
          if (!cleanSourcePath || cleanSourcePath.includes("link") || cleanSourcePath.includes("svg")) {
            continue;
          }

          const skillId = `${cleanSourcePath}/${slug}`;
          if (seenSlugs.has(skillId)) continue;
          seenSlugs.add(skillId);

          // 尝试从页面文本中提取安装数
          // 技能名后面通常跟着安装数（如 "2.9M", "840.3K" 等）
          const installPattern = new RegExp(
            `${slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^<]*?([\\d.]+[KM]?)`,
            "i",
          );
          const installMatch = html.match(installPattern);
          let stars: number | undefined;
          if (installMatch) {
            const num = installMatch[1];
            if (num.endsWith("K")) {
              stars = Math.round(parseFloat(num) * 1000);
            } else if (num.endsWith("M")) {
              stars = Math.round(parseFloat(num) * 1000000);
            } else {
              stars = parseInt(num, 10) || undefined;
            }
          }

          // 显示名：将 slug 转为可读名称
          const displayName = slug
            .split("-")
            .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
            .join(" ");

          skills.push({
            id: `${source.id}:${skillId}`,
            name: slug,
            displayName,
            description: `Skills.sh skill from ${cleanSourcePath}`,
            author: cleanSourcePath,
            sourceId: source.id,
            sourceName: source.name,
            downloadUrl: `https://github.com/${cleanSourcePath}`,
            repoUrl: `${baseUrl}/${cleanSourcePath}/${slug}`,
            stars,
            installType: "dir",
            repoFullName: cleanSourcePath,
            branch: "main",
            dirPath: slug,
          });
        }
      } catch (err) {
        console.warn(`[SkillMarket] Skills.sh HTML scrape error for ${view.label}:`, err);
      }
    }

    console.log(`[SkillMarket] Skills.sh HTML: scraped ${skills.length} skills`);
  } catch (err) {
    console.error(`[SkillMarket] Error scraping Skills.sh HTML:`, err);
  }

  return skills;
}

// ========== SkillHub API Adapter ==========

/**
 * 从 SkillHub REST API 获取技能列表。
 *
 * SkillHub 是开源 AI Agent 技能市场（skills.palebluedot.live），
 * 索引了 25 万+ 技能，提供公开 REST API（无需认证）：
 *   GET /api/skills?q=&limit=&page=    → 搜索 + 分页
 *   GET /api/skills/featured            → 精选技能
 *   GET /api/skills/:id                 → 技能详情
 *   GET /api/skill-files/zip?skillId=   → 下载 ZIP
 *
 * 匿名限流：120 请求/分钟（读）、60 请求/分钟（搜索）
 *
 * API 文档：https://skills.palebluedot.live/en/docs/api
 */
async function fetchSkillHubAPISkills(source: MarketSource): Promise<MarketSkill[]> {
  const skills: MarketSkill[] = [];
  const MAX_PAGES = 2; // 最多 2 页 × 100 条/页 = 200 条
  const PAGE_SIZE = 100;

  try {
    const baseUrl = source.url.replace(/\/$/, "");
    const headers: Record<string, string> = {
      "Accept": "application/json",
    };

    // 并行请求 featured + 各页数据（之前是串行，4 个请求 × 15s 超时 = 最长 60s）
    const pageUrls: string[] = [];
    pageUrls.push(`${baseUrl}/api/skills/featured`);
    for (let p = 0; p < MAX_PAGES; p++) {
      pageUrls.push(`${baseUrl}/api/skills?limit=${PAGE_SIZE}&page=${p}&sort=downloads`);
    }

    const results = await Promise.allSettled(
      pageUrls.map(url => httpGet(url, headers)),
    );

    const seenIds = new Set<string>();

    for (const result of results) {
      if (result.status !== "fulfilled") continue;
      const resp = result.value;
      if (resp.status !== 200) continue;

      try {
        const data = JSON.parse(resp.body);
        const items: any[] = data.data || data.skills || data.items || (Array.isArray(data) ? data : []);

        for (const item of items) {
          const skillId = item.id || item._id || `${item.owner || item.source}/${item.slug || item.name}`;
          const skillKey = `${source.id}:${skillId}`;
          if (seenIds.has(skillKey)) continue;
          seenIds.add(skillKey);

          const slug = item.slug || item.name || skillId;
          const author = item.owner || item.source || item.author || "";
          const downloadUrl = item.zipUrl || item.downloadUrl ||
            (item._id || item.id ?
              `${baseUrl}/api/skill-files/zip?skillId=${item._id || item.id}` :
              `${baseUrl}/api/skill-files/zip?skillId=${slug}`);

          skills.push({
            id: skillKey,
            name: slug,
            displayName: item.displayName || item.name || slug,
            description: item.description || item.summary || "无描述",
            author,
            version: item.version,
            tags: Array.isArray(item.tags) ? item.tags : (Array.isArray(item.categories) ? item.categories : []),
            sourceId: source.id,
            sourceName: source.name,
            downloadUrl,
            repoUrl: item.url || item.repoUrl || (author ? `https://github.com/${author}` : undefined),
            stars: item.downloads || item.installs || item.stars,
            lastUpdated: item.updatedAt || item.updated_at,
            installType: "zip",
            repoFullName: item.repoFullName || (author ? `${author}/${slug}` : undefined),
            branch: item.branch || "main",
          });
        }
      } catch (e) {
        console.warn("[SkillMarket] SkillHub parse error:", e);
      }
    }

    console.log(`[SkillMarket] SkillHub API: fetched ${skills.length} skills`);
  } catch (err) {
    console.error(`[SkillMarket] Error fetching SkillHub skills:`, err);
  }

  return skills;
}

/**
 * 从 SkillHub 指定端点获取技能并追加到 skills 数组。
 * 返回本次获取到的技能数量。
 */
async function fetchSkillHubEndpoint(
  url: string,
  source: MarketSource,
  headers: Record<string, string>,
  skills: MarketSkill[],
): Promise<number> {
  const before = skills.length;
  const baseUrl = source.url.replace(/\/$/, "");

  try {
    const resp = await httpGet(url, headers);
    if (resp.status !== 200) {
      console.warn(`[SkillMarket] SkillHub endpoint failed: ${resp.status} for ${url}`);
      return 0;
    }

    const data = JSON.parse(resp.body);
    const items: any[] = data.data || data.skills || (Array.isArray(data) ? data : []);

    for (const item of items) {
      const skillId = item.id || item._id || `${item.owner || item.source}/${item.slug || item.name}`;
      const slug = item.slug || item.name || skillId;
      const author = item.owner || item.source || item.author || "";
      const downloadUrl = item.zipUrl || item.downloadUrl ||
        `${baseUrl}/api/skill-files/zip?skillId=${item._id || item.id || slug}`;

      skills.push({
        id: `${source.id}:${skillId}`,
        name: slug,
        displayName: item.displayName || item.name || slug,
        description: item.description || item.summary || "无描述",
        author,
        version: item.version,
        tags: item.tags || item.categories,
        sourceId: source.id,
        sourceName: source.name,
        downloadUrl,
        repoUrl: item.url || item.repoUrl || (author ? `https://github.com/${author}` : undefined),
        stars: item.downloads || item.installs || item.stars,
        lastUpdated: item.updatedAt || item.updated_at,
        installType: "zip",
        repoFullName: item.repoFullName || (author ? `${author}/${slug}` : undefined),
        branch: item.branch || "main",
      });
    }
  } catch (err) {
    console.warn(`[SkillMarket] SkillHub endpoint error for ${url}:`, err);
  }

  return skills.length - before;
}

// ========== CLI Subprocess Adapter (Generic) ==========

/**
 * 通过 CLI 子进程获取技能列表（如 skillhub-cli）。
 *
 * 工作流程：
 * 1. 调用 `<cliCommand> search ""` 或 `<cliCommand> list` 获取技能列表
 * 2. 解析 stdout 为 MarketSkill[]
 *
 * SkillHub CLI 输出格式（推测）：
 *   name        description                    author       downloads
 *   skill-1     First skill description         author1      123
 *   skill-2     Second skill description        author2      456
 *
 * 或 JSON 格式：
 *   [{"name": "skill-1", "description": "...", "author": "..."}]
 */
async function fetchCLISkills(source: MarketSource): Promise<MarketSkill[]> {
  const skills: MarketSkill[] = [];

  if (!source.cliCommand) {
    console.warn(`[SkillMarket] CLI source ${source.id} has no cliCommand configured`);
    return skills;
  }

  try {
    const { executeCommand } = await import("../file-api");

    // 尝试 JSON 输出格式优先（skillhub search --json）
    let stdout = "";
    let stderr = "";
    let exitCode: number | undefined;

    try {
      // 尝试带 --json flag 获取结构化输出
      const result = await executeCommand(`${source.cliCommand} search --json`, undefined);
      stdout = result.stdout;
      stderr = result.stderr;
      exitCode = result.exitCode;
    } catch {
      // --json 不支持，尝试普通 search
      try {
        const result = await executeCommand(`${source.cliCommand} search`, undefined);
        stdout = result.stdout;
        stderr = result.stderr;
        exitCode = result.exitCode;
      } catch (err2: any) {
        // CLI 未安装，抛出描述性错误以便 UI 展示
        const errMsg = `CLI "${source.cliCommand}" 未安装。请运行 npm i -g ${source.cliCommand} 安装后重试。`;
        console.warn(`[SkillMarket] ${errMsg}`);
        throw new Error(errMsg);
      }
    }

    if (exitCode !== 0 && exitCode !== undefined) {
      console.warn(`[SkillMarket] CLI "${source.cliCommand}" exited with code ${exitCode}: ${stderr}`);
      return skills;
    }

    // 尝试解析 JSON 输出
    const trimmed = stdout.trim();
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      try {
        const data = JSON.parse(trimmed);
        const items: any[] = Array.isArray(data) ? data : (data.data || data.items || []);

        for (const item of items) {
          const name = item.name || item.slug || "";
          if (!name) continue;

          skills.push({
            id: `${source.id}:${name}`,
            name,
            displayName: item.displayName || item.name || name,
            description: item.description || "无描述",
            author: item.author || item.owner || "",
            version: item.version,
            tags: item.tags,
            sourceId: source.id,
            sourceName: source.name,
            downloadUrl: "", // CLI 安装不需要 downloadUrl
            repoUrl: item.url || item.repoUrl,
            stars: item.downloads || item.installs,
            lastUpdated: item.updatedAt,
            installType: "cli" as any, // 标记为 CLI 安装类型
          });
        }
        return skills;
      } catch {
        // JSON 解析失败，尝试表格解析
      }
    }

    // 解析表格格式输出（制表符或空格分隔）
    const lines = trimmed.split("\n").filter((l) => l.trim());
    if (lines.length > 1) {
      // 跳过表头
      for (let i = 1; i < lines.length; i++) {
        const parts = lines[i].split(/\s{2,}|\t/).filter((p) => p.trim());
        if (parts.length < 1) continue;

        const name = parts[0].trim();
        const description = parts[1]?.trim() || "无描述";
        const author = parts[2]?.trim() || "";

        skills.push({
          id: `${source.id}:${name}`,
          name,
          displayName: name,
          description,
          author,
          sourceId: source.id,
          sourceName: source.name,
          downloadUrl: "",
          installType: "cli" as any,
        });
      }
    }
  } catch (err) {
    console.error(`[SkillMarket] Error fetching CLI skills for ${source.id}:`, err);
  }

  return skills;
}

/**
 * 通过 CLI 子进程安装技能（如 skillhub-cli）。
 *
 * 调用 `<cliCommand> install <skillName>` 安装技能。
 * CLI 自动将技能文件下载到本地，我们只需将安装结果同步到 registry。
 */
async function installCLISkill(
  skill: MarketSkill,
  onProgress?: InstallProgressCallback,
): Promise<InstallResult> {
  const { executeCommand } = await import("../file-api");
  const { getSkillRegistry, parseSkillMarkdown } = await import("./skill");
  const { readFile } = await import("../file-api");

  onProgress?.(10, `正在通过 CLI 安装: ${skill.name}...`);

  try {
    // 查找技能的 MarketSource 以获取 cliCommand
    const sources = getMarketSources();
    const source = sources.find((s) => s.id === skill.sourceId);
    if (!source?.cliCommand) {
      return { success: false, error: "未找到 CLI 命令配置" };
    }

    onProgress?.(30, `执行 ${source.cliCommand} install ${skill.name}...`);

    const result = await executeCommand(
      `${source.cliCommand} install ${skill.name}`,
      undefined,
    );

    if (result.exitCode !== 0 && result.exitCode !== undefined) {
      return {
        success: false,
        error: `CLI 安装失败 (exit ${result.exitCode}): ${result.stderr}`,
      };
    }

    onProgress?.(70, "CLI 安装完成，正在注册技能...");

    // CLI 安装后，技能文件通常在 ~/.skillhub/skills/ 或类似目录
    // 尝试查找并注册
    const skillsDir = await getSkillsDir();
    const sep = skillsDir.includes("/") && !skillsDir.includes("\\") ? "/" : "\\";
    const skillDir = `${skillsDir}${sep}${skill.name}`;

    // 尝试读取 SKILL.md
    try {
      const skillMdPath = `${skillDir}${sep}SKILL.md`;
      const skillMdContent = await readFile(skillMdPath);
      const skillDef = parseSkillMarkdown(skillMdContent, skillMdPath);
      if (skillDef) {
        skillDef.source = "user";
        skillDef.filePath = skillDir;
        skillDef.enabled = true;
        getSkillRegistry().register(skillDef);
      }
    } catch {
      // SKILL.md 可能不在预期位置，尝试在 CLI 输出中查找路径
      console.log(`[SkillMarket] CLI install output: ${result.stdout.substring(0, 200)}`);
    }

    onProgress?.(100, `技能 "${skill.name}" 安装成功！`);

    return {
      success: true,
      skillName: skill.name,
      filesWritten: 1,
    };
  } catch (err: any) {
    return {
      success: false,
      error: `CLI 安装失败: ${err.message || String(err)}`,
    };
  }
}

// ========== Public API ==========

/** 市场搜索结果 */
export interface MarketSearchResult {
  skills: MarketSkill[];
  errors: Array<{ sourceId: string; sourceName: string; error: string }>;
}

/**
 * 从所有启用的市场源获取技能列表。
 * @param sources 可选，默认使用 getMarketSources()
 * @param onSourceLoaded 每个源加载完成时的回调（用于渐进式 UI 更新）
 */
export async function listMarketSkills(
  sources?: MarketSource[],
  onSourceLoaded?: (sourceId: string, skills: MarketSkill[]) => void,
): Promise<MarketSearchResult> {
  const activeSources = (sources || getMarketSources()).filter((s) => s.enabled);
  const allSkills: MarketSkill[] = [];
  const errors: Array<{ sourceId: string; sourceName: string; error: string }> = [];

  // 获取已安装技能名列表，用于标记 installed 状态
  const registry = getSkillRegistry();
  const installedNames = new Set(registry.getAll().map((s) => s.name));

  // 并行加载所有源（每个源 12 秒超时保护）
  const LIST_SOURCE_TIMEOUT_MS = 12_000;
  const promises = activeSources.map(async (source) => {
    try {
      let skills: MarketSkill[] = [];
      const sourcePromise = (async () => {
        switch (source.type) {
        case "github-repo":
          skills = await fetchGitHubRepoSkills(source);
          break;
        case "github-search":
          skills = await fetchGitHubSearchSkills(source);
          break;
        case "builtin":
          skills = await fetchBuiltinSkills(source);
          break;
        case "clawhub-api":
          skills = await fetchClawHubSkills(source);
          break;
        case "skills-sh-api":
          skills = await fetchSkillsShSkills(source);
          break;
        case "skillhub-api":
          skills = await fetchSkillHubAPISkills(source);
          break;
        case "cli":
          skills = await fetchCLISkills(source);
          break;
      }
        return skills;
      })();

      // 超时保护：单个源超过 12 秒则返回空结果
      skills = await Promise.race([
        sourcePromise,
        new Promise<MarketSkill[]>((resolve) =>
          setTimeout(() => {
            console.warn(`[SkillMarket] Source "${source.name}" timed out after ${LIST_SOURCE_TIMEOUT_MS}ms`);
            resolve([]);
          }, LIST_SOURCE_TIMEOUT_MS)
        ),
      ]);

      // 标记已安装状态
      for (const skill of skills) {
        if (installedNames.has(skill.name)) {
          skill.installed = true;
        }
      }

      allSkills.push(...skills);
      onSourceLoaded?.(source.id, skills);
    } catch (err: any) {
      errors.push({
        sourceId: source.id,
        sourceName: source.name,
        error: err.message || String(err),
      });
      onSourceLoaded?.(source.id, []);
    }
  });

  await Promise.all(promises);

  return { skills: allSkills, errors };
}

/**
 * 获取技能安装目录。
 */
async function getSkillsDir(): Promise<string> {
  const dataDir = await tauriInvoke("get_app_data_dir");
  const sep = dataDir.includes("/") && !dataDir.includes("\\") ? "/" : "\\";
  return `${dataDir}.codem${sep}skills`;
}

/**
 * 下载并安装市场技能。
 * @param skill 市场技能条目
 * @param onProgress 安装进度回调
 * @param overwrite 是否覆盖已存在的技能
 */
export async function installMarketSkill(
  skill: MarketSkill,
  onProgress?: InstallProgressCallback,
  overwrite: boolean = false,
): Promise<InstallResult> {
  // 内置技能无需安装
  if (skill.installType === "builtin") {
    return {
      success: true,
      skillName: skill.name,
      filesWritten: 0,
    };
  }

  // CLI 类型技能通过 CLI 子进程安装（如 skillhub install）
  if (skill.installType === "cli" as any) {
    return await installCLISkill(skill, onProgress);
  }

  try {
    onProgress?.(5, "正在准备下载...");

    // 对于 dir 类型的 GitHub 技能，直接通过 Contents API 递归下载目录文件，
    // 而不是下载整个仓库 zipball（某些仓库非常大，如 cloudflare-docs 1.4GB）
    if (skill.installType === "dir" && skill.dirPath && skill.repoFullName) {
      return await installSkillFromGitHubDir(skill, onProgress, overwrite);
    }

    // 获取临时文件路径
    const skillsDir = await getSkillsDir();
    const sep = skillsDir.includes("/") && !skillsDir.includes("\\") ? "/" : "\\";
    const tempZipPath = `${skillsDir}${sep}.tmp${sep}${skill.sourceId}-${skill.name}.zip`;

    // 修正 downloadUrl：确保是有效的 ZIP 下载链接
    let downloadUrl = skill.downloadUrl;
    if (!downloadUrl) {
      return {
        success: false,
        error: "该技能没有可用的下载链接（downloadUrl 为空）。请尝试其他来源。",
      };
    }

    // Skills.sh HTML 抓取的 downloadUrl 是 GitHub 仓库主页（https://github.com/owner/repo）
    // 需要转换为 zipball URL，并获取仓库真实的默认分支（不能假设是 main）
    if (downloadUrl.startsWith("https://github.com/") && !downloadUrl.includes("/zipball/") && !downloadUrl.includes("/archive/")) {
      const repoPath = downloadUrl.replace("https://github.com/", "");
      // 获取仓库真实默认分支（避免 branch=main 导致 404）
      let branch = skill.branch || "main";
      try {
        const repoResp = await httpGet(`https://api.github.com/repos/${repoPath}`, githubApiHeaders());
        if (repoResp.status === 200) {
          const repoInfo = JSON.parse(repoResp.body);
          branch = repoInfo.default_branch || branch;
        }
      } catch (err) {
        console.warn(`[SkillMarket] Failed to get default branch for ${repoPath}, using ${branch}:`, err);
      }
      downloadUrl = `https://api.github.com/repos/${repoPath}/zipball/${branch}`;
    }

    onProgress?.(15, `正在下载技能包: ${skill.displayName}...`);

    // 通过 Rust 层下载 ZIP 文件
    await httpDownload(downloadUrl, tempZipPath, githubApiHeaders());

    onProgress?.(40, "正在读取下载文件...");

    // 读取下载的 ZIP 文件为 base64
    const { invoke } = (window as any).__TAURI__?.core || {};
    const base64Data = await invoke("read_file", { path: tempZipPath, encoding: "base64" });

    // 将 base64 转换为 Uint8Array
    const binaryString = atob(base64Data);
    const zipData = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      zipData[i] = binaryString.charCodeAt(i);
    }

    // 清理临时文件
    try {
      await deletePath(tempZipPath);
    } catch {
      // Ignore cleanup errors
    }

    onProgress?.(55, "正在解压和安装...");

    // 如果是目录类型，需要过滤只安装指定目录
    if (skill.installType === "dir" && skill.dirPath) {
      return await installSkillFromZipFiltered(zipData, skill.dirPath, onProgress, overwrite, skill.name);
    }

    // 普通 ZIP 安装
    const result = await installSkillFromZip(zipData, onProgress, overwrite, skill.name);

    // P3-27: Record audit entry on successful install
    if (result.success) {
      try {
        const { unzipSync, strFromU8 } = await import("fflate");
        const files = unzipSync(new Uint8Array(zipData));
        const fileMap = new Map<string, string>();
        for (const [path, data] of Object.entries(files)) {
          if (path.endsWith("/") || (data as Uint8Array).length > 1024 * 1024) continue;
          try { fileMap.set(path, strFromU8(data as Uint8Array)); } catch (e) { console.warn('[skill-market-client.ts]', e) }
        }
        const hash = computeContentHash(fileMap);
        addInstallAuditEntry({
          skillName: result.skillName || skill.name,
          sourceId: skill.sourceId,
          installedAt: Date.now(),
          auditLevel: "safe",
          filesWritten: result.filesWritten || 0,
          contentHash: hash,
          version: skill.version,
          author: skill.author,
        });
      } catch (e) { console.warn('[skill-market-client.ts]', e) }
    }

    return result;
  } catch (err: any) {
    return {
      success: false,
      error: `市场安装失败: ${err.message || String(err)}`,
    };
  }
}

/**
 * 通过 GitHub Contents API 递归下载仓库中的指定目录，直接安装技能。
 *
 * 用于 dir 类型的 GitHub 技能（如 Skills.sh 的技能），避免下载整个仓库 zipball。
 * 工作流程：
 * 1. 获取仓库默认分支
 * 2. 递归遍历 dirPath 目录中的所有文件
 * 3. 逐个通过 raw.githubusercontent.com 下载文件内容
 * 4. 写入到本地技能目录
 * 5. 解析 SKILL.md 并注册
 */
async function installSkillFromGitHubDir(
  skill: MarketSkill,
  onProgress?: InstallProgressCallback,
  overwrite: boolean = false,
): Promise<InstallResult> {
  const { getSkillRegistry, parseSkillMarkdown } = await import("./skill");
  const { writeFile } = await import("../file-api");

  try {
    const repoFullName = skill.repoFullName!;
    const dirPath = skill.dirPath!;

    // 获取仓库默认分支
    onProgress?.(10, `正在获取仓库信息: ${repoFullName}...`);
    let branch = skill.branch || "main";
    try {
      const repoResp = await httpGet(`https://api.github.com/repos/${repoFullName}`, githubApiHeaders());
      if (repoResp.status === 200) {
        const repoInfo = JSON.parse(repoResp.body);
        branch = repoInfo.default_branch || branch;
      }
    } catch (err) {
      console.warn(`[SkillMarket] Failed to get default branch for ${repoFullName}, using ${branch}:`, err);
    }

    // 递归遍历目录，收集所有文件
    onProgress?.(20, `正在遍历目录: ${dirPath}...`);

    interface FileEntry {
      path: string;     // 相对于 dirPath 的路径
      downloadUrl: string;  // raw.githubusercontent.com URL
      size: number;
    }

    const files: FileEntry[] = [];
    const allowedExtensions = new Set([
      ".md", ".txt", ".json", ".yaml", ".yml",
      ".ts", ".tsx", ".js", ".jsx", ".mjs",
      ".py", ".sh", ".bat", ".ps1",
      ".css", ".html", ".svg",
      ".png", ".jpg", ".jpeg", ".gif", ".ico",
      ".toml", ".ini", ".cfg",
    ]);

    async function traverseDir(subPath: string): Promise<void> {
      const contentsUrl = `https://api.github.com/repos/${repoFullName}/contents/${subPath}?ref=${branch}`;
      const resp = await httpGet(contentsUrl, githubApiHeaders());
      if (resp.status !== 200) {
        console.warn(`[SkillMarket] Contents API failed for ${subPath}: ${resp.status}`);
        return;
      }
      const items = JSON.parse(resp.body);
      if (!Array.isArray(items)) return;

      for (const item of items) {
        if (item.type === "file") {
          // 检查扩展名
          const ext = item.name.substring(item.name.lastIndexOf(".")).toLowerCase();
          if (!allowedExtensions.has(ext) && !item.name.endsWith("SKILL.md")) continue;
          // 检查大小（跳过大文件）
          if (item.size && item.size > 1024 * 1024) continue;

          // raw URL
          const rawUrl = `https://raw.githubusercontent.com/${repoFullName}/${branch}/${item.path}`;
          // 相对于 dirPath 的路径
          let relativePath = item.path;
          if (relativePath.startsWith(dirPath + "/")) {
            relativePath = relativePath.substring(dirPath.length + 1);
          }
          files.push({ path: relativePath, downloadUrl: rawUrl, size: item.size || 0 });
        } else if (item.type === "dir") {
          await traverseDir(item.path);
        }
      }
    }

    await traverseDir(dirPath);

    if (files.length === 0) {
      return {
        success: false,
        error: `目录 "${dirPath}" 中未找到可安装的文件。请检查技能路径是否正确。`,
      };
    }

    // 检查是否有 SKILL.md
    const skillMdFile = files.find((f) => f.path.endsWith("SKILL.md"));
    if (!skillMdFile) {
      return {
        success: false,
        error: `目录 "${dirPath}" 中未找到 SKILL.md 文件。`,
      };
    }

    // 先下载 SKILL.md 解析技能信息
    onProgress?.(40, "正在解析技能元数据...");
    const mdResp = await httpGet(skillMdFile.downloadUrl);
    if (mdResp.status !== 200) {
      return { success: false, error: "下载 SKILL.md 失败。" };
    }
    const skillDef = parseSkillMarkdown(mdResp.body, skillMdFile.path);
    if (!skillDef) {
      return { success: false, error: "SKILL.md 解析失败。" };
    }

    // 使用 preferredName 覆盖技能名
    if (skill.name) {
      skillDef.name = skill.name;
    }

    // 检查是否已存在
    const registry = getSkillRegistry();
    const existing = registry.get(skillDef.name);
    if (existing && !overwrite) {
      return {
        success: false,
        error: `技能 "${skillDef.name}" 已存在。是否覆盖安装？`,
        skillName: skillDef.name,
      };
    }

    // 获取安装目录
    const skillsDir = await getSkillsDir();
    const sep = skillsDir.includes("/") && !skillsDir.includes("\\") ? "/" : "\\";
    const skillDir = `${skillsDir}${sep}${skillDef.name}`;

    // 下载并写入所有文件（SKILL.md 已在前面下载过，跳过重复下载）
    onProgress?.(50, `正在下载技能文件 (${files.length} 个)...`);
    let filesWritten = 0;
    const downloadedContents = new Map<string, string>(); // for audit

    // SKILL.md 的内容已在前面下载，直接加入 audit map
    downloadedContents.set(skillMdFile.path, mdResp.body);

    for (const file of files) {
      // 跳过 SKILL.md（已下载）
      if (file.path === skillMdFile.path) {
        const fullPath = `${skillDir}${sep}${file.path.replace(/\//g, sep)}`;
        await writeFile(fullPath, mdResp.body);
        filesWritten++;
        continue;
      }
      try {
        const fileResp = await httpGet(file.downloadUrl);
        if (fileResp.status !== 200) {
          console.warn(`[SkillMarket] Failed to download ${file.path}: ${fileResp.status}`);
          continue;
        }

        downloadedContents.set(file.path, fileResp.body);

        const fullPath = `${skillDir}${sep}${file.path.replace(/\//g, sep)}`;
        await writeFile(fullPath, fileResp.body);
        filesWritten++;

        const progress = 50 + Math.round((filesWritten / files.length) * 40);
        onProgress?.(progress, `写入文件: ${file.path}`);
      } catch (err) {
        console.warn(`[SkillMarket] Failed to write ${file.path}:`, err);
      }
    }

    if (filesWritten === 0) {
      return { success: false, error: "所有文件下载失败。" };
    }

    onProgress?.(95, "正在注册技能...");

    // 注册技能
    skillDef.source = "user";
    skillDef.filePath = skillDir;
    skillDef.enabled = true;
    registry.register(skillDef);

    // 审计记录（复用已下载的内容）
    try {
      const hash = computeContentHash(downloadedContents);
      addInstallAuditEntry({
        skillName: skillDef.name,
        sourceId: skill.sourceId,
        installedAt: Date.now(),
        auditLevel: "safe",
        filesWritten,
        contentHash: hash,
        version: skill.version,
        author: skill.author,
      });
    } catch (e) { console.warn('[skill-market-client.ts]', e) }

    onProgress?.(100, `技能 "${skillDef.name}" 安装成功！`);

    return {
      success: true,
      skillName: skillDef.name,
      skill: skillDef,
      filesWritten,
    };
  } catch (err: any) {
    return {
      success: false,
      error: `安装失败: ${err.message || String(err)}`,
    };
  }
}

/**
 * 从 ZIP 中只安装指定目录的技能。
 * 用于 GitHub 仓库目录型源（如 anthropics/skills 中的单个技能）。
 */
async function installSkillFromZipFiltered(
  zipData: Uint8Array,
  targetDir: string,
  onProgress?: InstallProgressCallback,
  overwrite: boolean = false,
  preferredName?: string,
): Promise<InstallResult> {
  const { unzipSync, strFromU8 } = await import("fflate");
  const { getSkillRegistry, parseSkillMarkdown } = await import("./skill");
  const { writeFile } = await import("../file-api");

  try {
    onProgress?.(60, "正在解压 ZIP 文件...");

    const files = unzipSync(zipData);
    const allPaths = Object.keys(files);

    // GitHub zipball 的路径格式：{repo}-{hash}/{dirPath}/...
    // targetDir 可能是多级路径（如 "skills/pdf"），需要按路径段匹配
    const targetSegments = targetDir.split("/").filter(Boolean);

    const targetPaths = allPaths.filter((p) => {
      const normalized = p.replace(/\\/g, "/");
      const parts = normalized.split("/").filter(Boolean);
      // GitHub zipball 第一级是 repo-hash，从第二级开始匹配
      if (parts.length < targetSegments.length + 1) return false;
      // 从 index 1 开始检查是否有连续的 targetSegments
      for (let i = 1; i <= parts.length - targetSegments.length; i++) {
        let match = true;
        for (let j = 0; j < targetSegments.length; j++) {
          if (parts[i + j] !== targetSegments[j]) {
            match = false;
            break;
          }
        }
        if (match) return true;
      }
      return false;
    });

    if (targetPaths.length === 0) {
      // dirPath 在 ZIP 中不存在（可能技能已改名或移除），fallback 到普通 ZIP 安装
      console.warn(`[SkillMarket] dirPath "${targetDir}" not found in ZIP, falling back to full ZIP install`);
      return await installSkillFromZip(zipData, onProgress, overwrite, preferredName);
    }

    // 确定实际的根前缀（如 "anthropics-skills-abc123/"）
    // 根前缀是 targetSegments 之前的所有路径段
    const firstPath = targetPaths[0].replace(/\\/g, "/");
    const firstParts = firstPath.split("/").filter(Boolean);
    // 找到 targetSegments 在路径中的起始位置
    let segStartIdx = -1;
    for (let i = 0; i <= firstParts.length - targetSegments.length; i++) {
      let match = true;
      for (let j = 0; j < targetSegments.length; j++) {
        if (firstParts[i + j] !== targetSegments[j]) {
          match = false;
          break;
        }
      }
      if (match) {
        segStartIdx = i;
        break;
      }
    }
    const rootPrefix = segStartIdx > 0 ? firstParts.slice(0, segStartIdx).join("/") + "/" : "";
    // 完整的目录前缀（根前缀 + targetDir + /）
    const fullDirPrefix = rootPrefix + targetDir + "/";

    // 查找 SKILL.md
    const skillMdPath = targetPaths.find((p) => p.replace(/\\/g, "/").endsWith("SKILL.md"));
    if (!skillMdPath) {
      return {
        success: false,
        error: "ZIP 中未找到 SKILL.md 文件。",
      };
    }

    // 解析 SKILL.md
    const skillMdContent = strFromU8(files[skillMdPath]);
    const skill = parseSkillMarkdown(skillMdContent, skillMdPath);
    if (!skill) {
      return { success: false, error: "SKILL.md 解析失败。" };
    }

    // 使用 preferredName 覆盖技能名（确保与市场显示一致）
    if (preferredName) {
      skill.name = preferredName;
    }

    // 检查是否已存在
    const registry = getSkillRegistry();
    const existing = registry.get(skill.name);
    if (existing && !overwrite) {
      return {
        success: false,
        error: `技能 "${skill.name}" 已存在。是否覆盖安装？`,
        skillName: skill.name,
      };
    }

    onProgress?.(75, `正在安装技能: ${skill.name}...`);

    // 获取安装目录
    const skillsDir = await getSkillsDir();
    const sep = skillsDir.includes("/") && !skillsDir.includes("\\") ? "/" : "\\";
    const skillDir = `${skillsDir}${sep}${skill.name}`;

    // 写入文件
    let filesWritten = 0;
    const allowedExtensions = new Set([
      ".md", ".txt", ".json", ".yaml", ".yml",
      ".ts", ".tsx", ".js", ".jsx", ".mjs",
      ".py", ".sh", ".bat", ".ps1",
      ".css", ".html", ".svg",
      ".png", ".jpg", ".jpeg", ".gif", ".ico",
      ".toml", ".ini", ".cfg",
    ]);

    for (const zipPath of targetPaths) {
      if (zipPath.endsWith("/") || zipPath.endsWith("\\")) continue;

      // 去除根前缀和目标目录前缀，得到相对路径
      let relativePath = zipPath.replace(/\\/g, "/").replace(fullDirPrefix, "");
      if (!relativePath || relativePath === zipPath.replace(/\\/g, "/")) {
        // 尝试只去除根前缀
        relativePath = zipPath.replace(/\\/g, "/").replace(rootPrefix, "");
        // 去除 targetDir/ 前缀
        if (relativePath.startsWith(targetDir + "/")) {
          relativePath = relativePath.substring(targetDir.length + 1);
        }
      }
      if (!relativePath) continue;

      // 检查扩展名
      const ext = relativePath.substring(relativePath.lastIndexOf(".")).toLowerCase();
      if (!allowedExtensions.has(ext)) continue;

      // 检查文件大小
      const fileData = files[zipPath];
      if (fileData.length > 1024 * 1024) continue;

      // 写入文件
      const fullPath = `${skillDir}${sep}${relativePath.replace(/\//g, sep)}`;
      const content = strFromU8(fileData);
      await writeFile(fullPath, content);
      filesWritten++;

      const progress = 75 + Math.round((filesWritten / targetPaths.length) * 20);
      onProgress?.(progress, `写入文件: ${relativePath}`);
    }

    onProgress?.(95, "正在注册技能...");

    // 注册技能
    skill.source = "user";
    skill.filePath = skillDir;
    skill.enabled = true;
    registry.register(skill);

    onProgress?.(100, `技能 "${skill.name}" 安装成功！`);

    return {
      success: true,
      skillName: skill.name,
      skill,
      filesWritten,
    };
  } catch (err: any) {
    return {
      success: false,
      error: `安装失败: ${err.message || String(err)}`,
    };
  }
}

/**
 * 检查市场技能是否已安装。
 */
export function isMarketSkillInstalled(skill: MarketSkill): boolean {
  const registry = getSkillRegistry();
  return registry.getAll().some((s) => s.name === skill.name);
}

/**
 * 增量联网搜索：在所有启用的市场源中搜索关键词。
 *
 * 与 listMarketSkills 不同，此函数会利用支持搜索 API 的市场源（如 SkillHub、Skills.sh）
 * 直接在服务端搜索，而非拉取全量列表后在本地过滤。
 *
 * 对于不支持服务端搜索的源（如 GitHub repo），仍然拉取全量后本地过滤。
 *
 * @param query 搜索关键词
 * @param sources 可选，默认使用 getMarketSources()
 * @param onSourceLoaded 每个源搜索完成时的回调
 */
export async function searchMarketSkillsOnline(
  query: string,
  sources?: MarketSource[],
  onSourceLoaded?: (sourceId: string, skills: MarketSkill[]) => void,
): Promise<MarketSearchResult> {
  const activeSources = (sources || getMarketSources()).filter((s) => s.enabled);
  const allSkills: MarketSkill[] = [];
  const errors: Array<{ sourceId: string; sourceName: string; error: string }> = [];

  // 获取已安装技能名列表
  const registry = getSkillRegistry();
  const installedNames = new Set(registry.getAll().map((s) => s.name));

  const q = query.toLowerCase().trim();

  // 为每个源设置超时，避免单个慢源卡住全部搜索
  const SOURCE_TIMEOUT_MS = 12_000; // 12 秒超时（略短于 Rust 端 15s http_get 超时）

  const promises = activeSources.map(async (source) => {
    try {
      let skills: MarketSkill[] = [];

      // 为单个源设置超时
      const sourcePromise = (async () => {
        // 对于 SkillHub，利用其服务端搜索 API
        if (source.type === "skillhub-api") {
          skills = await fetchSkillHubSearch(source, q);
        } else {
          // 其他源：全量拉取后在本地过滤
          skills = await fetchSkillsFromSource(source);
          // 本地过滤
          if (q) {
            skills = skills.filter((s) => {
              const tags = Array.isArray(s.tags) ? s.tags : [];
              const name = String(s.name || "");
              const displayName = String(s.displayName || "");
              const description = String(s.description || "");
              const author = s.author ? String(s.author) : "";
              return (
                name.toLowerCase().includes(q) ||
                displayName.toLowerCase().includes(q) ||
                description.toLowerCase().includes(q) ||
                author.toLowerCase().includes(q) ||
                tags.some((t) => String(t).toLowerCase().includes(q))
              );
            });
          }
        }
        return skills;
      })();

      // 超时保护：如果单个源超过 20 秒，返回空结果
      skills = await Promise.race([
        sourcePromise,
        new Promise<MarketSkill[]>((resolve) =>
          setTimeout(() => {
            console.warn(`[SkillMarket] Source "${source.name}" timed out after ${SOURCE_TIMEOUT_MS}ms`);
            resolve([]);
          }, SOURCE_TIMEOUT_MS)
        ),
      ]);

      // 标记已安装状态
      for (const skill of skills) {
        if (installedNames.has(skill.name)) {
          skill.installed = true;
        }
      }

      allSkills.push(...skills);
      onSourceLoaded?.(source.id, skills);
    } catch (err: any) {
      errors.push({
        sourceId: source.id,
        sourceName: source.name,
        error: err.message || String(err),
      });
      onSourceLoaded?.(source.id, []);
    }
  });

  await Promise.all(promises);

  return { skills: allSkills, errors };
}

/**
 * 从单个市场源获取技能（复用现有适配器）。
 */
async function fetchSkillsFromSource(source: MarketSource): Promise<MarketSkill[]> {
  switch (source.type) {
    case "github-repo":
      return await fetchGitHubRepoSkills(source);
    case "github-search":
      return await fetchGitHubSearchSkills(source);
    case "builtin":
      return await fetchBuiltinSkills(source);
    case "clawhub-api":
      return await fetchClawHubSkills(source);
    case "skills-sh-api":
      return await fetchSkillsShSkills(source);
    case "skillhub-api":
      return await fetchSkillHubAPISkills(source);
    case "cli":
      return await fetchCLISkills(source);
    default:
      return [];
  }
}

/**
 * 通过 SkillHub 服务端搜索 API 搜索技能。
 * GET /api/skills?q=<query>&limit=50&page=0
 */
async function fetchSkillHubSearch(source: MarketSource, query: string): Promise<MarketSkill[]> {
  const skills: MarketSkill[] = [];
  const MAX_PAGES = 2;
  const PAGE_SIZE = 50;

  try {
    const baseUrl = source.url.replace(/\/$/, "");
    const headers: Record<string, string> = {
      "Accept": "application/json",
    };

    let page = 0;
    let hasMore = true;
    const seenIds = new Set<string>();

    while (hasMore && page < MAX_PAGES) {
      const params = new URLSearchParams();
      params.set("q", query);
      params.set("limit", String(PAGE_SIZE));
      params.set("page", String(page));
      params.set("sort", "downloads");

      const resp = await httpGet(`${baseUrl}/api/skills?${params.toString()}`, headers);
      if (resp.status !== 200) {
        console.warn(`[SkillMarket] SkillHub search failed (page ${page}): ${resp.status}`);
        break;
      }

      const data = JSON.parse(resp.body);
      const items: any[] = data.data || data.skills || data.items || (Array.isArray(data) ? data : []);
      if (items.length === 0) break;

      for (const item of items) {
        const skillId = item.id || item._id || `${item.owner || item.source}/${item.slug || item.name}`;
        const skillKey = `${source.id}:${skillId}`;
        if (seenIds.has(skillKey)) continue;
        seenIds.add(skillKey);

        const slug = item.slug || item.name || skillId;
        const author = item.owner || item.source || item.author || "";
        const downloadUrl = item.zipUrl || item.downloadUrl ||
          (item._id || item.id ?
            `${baseUrl}/api/skill-files/zip?skillId=${item._id || item.id}` :
            `${baseUrl}/api/skill-files/zip?skillId=${slug}`);

        skills.push({
          id: skillKey,
          name: slug,
          displayName: item.displayName || item.name || slug,
          description: item.description || item.summary || "无描述",
          author,
          version: item.version,
          tags: Array.isArray(item.tags) ? item.tags : (Array.isArray(item.categories) ? item.categories : []),
          sourceId: source.id,
          sourceName: source.name,
          downloadUrl,
          repoUrl: item.url || item.repoUrl || (author ? `https://github.com/${author}` : undefined),
          stars: item.downloads || item.installs || item.stars,
          lastUpdated: item.updatedAt || item.updated_at,
          installType: "zip",
          repoFullName: item.repoFullName || (author ? `${author}/${slug}` : undefined),
          branch: item.branch || "main",
        });
      }

      const hasMoreFlag = data.hasMore !== undefined ? data.hasMore :
        (data.pagination ? data.pagination.hasMore : undefined);
      if (hasMoreFlag === false) break;
      if (items.length < PAGE_SIZE) break;
      page++;
    }

    console.log(`[SkillMarket] SkillHub search "${query}": found ${skills.length} skills`);
  } catch (err) {
    console.error(`[SkillMarket] Error searching SkillHub:`, err);
  }

  return skills;
}

/**
 * P3-27: 预检安装 — 在下载 ZIP 后、实际安装前进行安全审计。
 *
 * 工作流程：
 * 1. 解压 ZIP 但不写入文件系统
 * 2. 提取所有文件内容
 * 3. 执行安全审计（恶意代码检测、权限声明验证）
 * 4. 返回审计结果 + 解压后的文件数据（供后续安装使用）
 *
 * @param skill 市场技能条目
 * @param onProgress 进度回调
 * @returns 审计结果 + 文件数据，或 null（下载失败时）
 */
export async function preAuditSkill(
  skill: MarketSkill,
  onProgress?: InstallProgressCallback,
): Promise<{ audit: SkillAuditResult; files: Map<string, string>; skillMdPath: string } | null> {
  if (skill.installType === "builtin") {
    return { audit: { overall: "safe", findings: [], declaredPermissions: [], timestamp: Date.now() }, files: new Map(), skillMdPath: "" };
  }
  if (skill.installType === "cli" as any) {
    return { audit: { overall: "safe", findings: [], declaredPermissions: [], timestamp: Date.now() }, files: new Map(), skillMdPath: "" };
  }
  try {
    onProgress?.(5, "Downloading skill package...");
    const skillsDir = await getSkillsDir();
    const sep = skillsDir.includes("/") && !skillsDir.includes("\\") ? "/" : "\\";
    const tempZipPath = `${skillsDir}${sep}.tmp${sep}${skill.sourceId}-${skill.name}.zip`;

    onProgress?.(15, `Downloading: ${skill.displayName}...`);
    await httpDownload(skill.downloadUrl, tempZipPath, githubApiHeaders());

    onProgress?.(40, "Reading downloaded file...");
    const { invoke } = (window as any).__TAURI__?.core || {};
    const base64Data = await invoke("read_file", { path: tempZipPath, encoding: "base64" });
    const binaryString = atob(base64Data);
    const zipData = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) { zipData[i] = binaryString.charCodeAt(i); }
    try { await deletePath(tempZipPath); } catch (e) { console.warn('[skill-market-client.ts]', e) }

    onProgress?.(55, "Extracting and auditing...");
    const { unzipSync, strFromU8 } = await import("fflate");
    const rawFiles = unzipSync(zipData);
    const allPaths = Object.keys(rawFiles);

    let targetPaths = allPaths;
    let rootPrefix = "";

    if (skill.installType === "dir" && skill.dirPath) {
      const targetSegments = skill.dirPath.split("/").filter(Boolean);
      targetPaths = allPaths.filter((p) => {
        const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
        if (parts.length < targetSegments.length + 1) return false;
        for (let i = 1; i <= parts.length - targetSegments.length; i++) {
          let match = true;
          for (let j = 0; j < targetSegments.length; j++) { if (parts[i + j] !== targetSegments[j]) { match = false; break; } }
          if (match) return true;
        }
        return false;
      });
      const firstPath = targetPaths[0]?.replace(/\\/g, "/") || "";
      const firstParts = firstPath.split("/").filter(Boolean);
      let segStartIdx = -1;
      for (let i = 0; i <= firstParts.length - targetSegments.length; i++) {
        let match = true;
        for (let j = 0; j < targetSegments.length; j++) { if (firstParts[i + j] !== targetSegments[j]) { match = false; break; } }
        if (match) { segStartIdx = i; break; }
      }
      rootPrefix = segStartIdx > 0 ? firstParts.slice(0, segStartIdx).join("/") + "/" : "";
    } else {
      const skillMdPath = allPaths.find(p => p.endsWith("SKILL.md"));
      if (skillMdPath) {
        const parts = skillMdPath.replace(/\\/g, "/").split("/");
        if (parts.length > 1) { rootPrefix = parts.slice(0, -1).join("/") + "/"; }
      }
    }

    const skillMdPath = targetPaths.find(p => p.replace(/\\/g, "/").endsWith("SKILL.md"));
    if (!skillMdPath) return null;

    const skillMdContent = strFromU8(rawFiles[skillMdPath]);

    const allowedExtensions = new Set([".md",".txt",".json",".yaml",".yml",".ts",".tsx",".js",".jsx",".mjs",".py",".sh",".bat",".ps1",".css",".html",".svg",".toml",".ini",".cfg"]);
    const fileMap = new Map<string, string>();
    for (const zipPath of targetPaths) {
      if (zipPath.endsWith("/") || zipPath.endsWith("\\")) continue;
      const relativePath = zipPath.replace(/\\/g, "/").replace(rootPrefix, "");
      if (!relativePath) continue;
      const ext = relativePath.substring(relativePath.lastIndexOf(".")).toLowerCase();
      if (!allowedExtensions.has(ext)) continue;
      const fileData = rawFiles[zipPath];
      if (fileData.length > 1024 * 1024) continue;
      try { fileMap.set(relativePath, strFromU8(fileData)); } catch (e) { console.warn('[skill-market-client.ts]', e) }
    }

    const audit = auditSkillInstallation(fileMap, skillMdContent);
    onProgress?.(100, "Audit complete");
    return { audit, files: fileMap, skillMdPath };
  } catch (err) {
    console.error("[SkillMarket] Pre-audit failed:", err);
    return null;
  }
}

/**
 * 获取市场源图标。
 */
export function getSourceIcon(source: MarketSource): string {
  return source.icon || "📦";
}

// ========== Skill Publishing ==========

/** 发布目标市场类型 */
export type PublishTarget = "clawhub" | "github" | "cli";

/** 发布配置 */
export interface PublishConfig {
  /** 目标市场 */
  target: PublishTarget;
  /** 技能本地路径（~/.codem/skills/<name>） */
  skillPath: string;
  /** 技能名称（slug） */
  slug: string;
  /** 显示名称 */
  displayName: string;
  /** 版本号（semver） */
  version: string;
  /** 变更日志 */
  changelog?: string;
  /** 标签（逗号分隔，默认 "latest"） */
  tags?: string;
  /** 目标市场源 ID（用于 CLI 类型市场） */
  sourceId?: string;
  /**
   * GitHub 仓库配置（仅 target=github 时使用）
   * 如果指定 repoName，会尝试通过 gh CLI 创建仓库并推送
   */
  githubRepoName?: string;
  /** GitHub 仓库可见性 */
  githubPrivate?: boolean;
}

/** 发布结果 */
export interface PublishResult {
  success: boolean;
  /** 发布后的技能 URL */
  url?: string;
  /** 发布后的技能 ID */
  publishedId?: string;
  /** 错误信息 */
  error?: string;
  /** CLI 输出（用于调试） */
  rawOutput?: string;
}

/** 可发布的市场信息 */
export interface PublishableMarket {
  id: string;
  name: string;
  target: PublishTarget;
  icon: string;
  /** 是否已就绪（CLI 已安装、已登录等） */
  ready: boolean;
  /** 未就绪原因 */
  notReadyReason?: string;
}

/**
 * 检查 CLI 工具是否已安装。
 */
async function isCLIInstalled(command: string): Promise<boolean> {
  try {
    const { executeCommand } = await import("../file-api");
    const result = await executeCommand(`${command} --version`, undefined);
    return result.exitCode === 0 || result.exitCode === undefined;
  } catch {
    return false;
  }
}

/**
 * 检查 ClawHub CLI 登录状态。
 */
async function checkClawHubAuth(): Promise<{ authenticated: boolean; user?: string }> {
  try {
    const { executeCommand } = await import("../file-api");
    const result = await executeCommand("clawhub whoami", undefined);
    if (result.exitCode === 0 && result.stdout.trim()) {
      return { authenticated: true, user: result.stdout.trim() };
    }
    return { authenticated: false };
  } catch {
    return { authenticated: false };
  }
}

/**
 * 列出所有支持发布的市场源。
 * 检查每个市场的就绪状态（CLI 是否安装、是否登录等）。
 */
export async function listPublishableMarkets(): Promise<PublishableMarket[]> {
  const markets: PublishableMarket[] = [];

  // 1. ClawHub — 通过 clawhub CLI 发布
  const clawhubInstalled = await isCLIInstalled("clawhub");
  let clawhubReady = clawhubInstalled;
  let clawhubNotReadyReason: string | undefined;

  if (clawhubInstalled) {
    const auth = await checkClawHubAuth();
    if (!auth.authenticated) {
      clawhubReady = false;
      clawhubNotReadyReason = "未登录，请运行 clawhub login";
    }
  } else {
    clawhubNotReadyReason = "未安装 clawhub CLI，请运行 npm i -g clawhub";
  }

  markets.push({
    id: "clawhub",
    name: "ClawHub.ai",
    target: "clawhub",
    icon: "🦞",
    ready: clawhubReady,
    notReadyReason: clawhubNotReadyReason,
  });

  // 2. GitHub — 通过 gh CLI 创建仓库 + 推送
  const ghInstalled = await isCLIInstalled("gh");
  markets.push({
    id: "github",
    name: "GitHub 仓库",
    target: "github",
    icon: "🐙",
    ready: ghInstalled,
    notReadyReason: ghInstalled ? undefined : "未安装 GitHub CLI，请运行 winget install GitHub.cli",
  });

  // 3. CLI 类型市场（如 SkillHub，如果支持 publish）
  const sources = getMarketSources();
  for (const source of sources) {
    if (source.type === "cli" && source.cliCommand) {
      const cliReady = await isCLIInstalled(source.cliCommand);
      markets.push({
        id: source.id,
        name: source.name,
        target: "cli",
        icon: source.icon || "📦",
        ready: cliReady,
        notReadyReason: cliReady ? undefined : `未安装 ${source.cliCommand} CLI`,
      });
    }
  }

  return markets;
}

/**
 * 发布技能到 ClawHub。
 * 调用 `clawhub skill publish <path>` CLI 命令。
 */
async function publishToClawHub(config: PublishConfig): Promise<PublishResult> {
  const { executeCommand } = await import("../file-api");

  const parts = [
    "clawhub", "skill", "publish", `"${config.skillPath}"`,
    "--slug", config.slug,
    "--name", `"${config.displayName}"`,
    "--version", config.version,
  ];
  if (config.changelog) {
    parts.push("--changelog", `"${config.changelog}"`);
  }
  parts.push("--tags", config.tags || "latest");

  try {
    const result = await executeCommand(parts.join(" "), undefined);
    const output = (result.stdout || "") + (result.stderr ? "\n" + result.stderr : "");

    if (result.exitCode !== 0 && result.exitCode !== undefined) {
      return {
        success: false,
        error: `clawhub publish 失败 (exit ${result.exitCode}): ${result.stderr || output}`,
        rawOutput: output,
      };
    }

    // 从输出中提取技能 URL
    // clawhub CLI 通常输出类似 "Published to https://clawhub.ai/<user>/skills/<slug>"
    const urlMatch = output.match(/https?:\/\/[^\s]+clawhub[^\s]*/i);
    const url = urlMatch ? urlMatch[0] : `https://clawhub.ai/skills/${config.slug}`;

    return {
      success: true,
      url,
      publishedId: config.slug,
      rawOutput: output,
    };
  } catch (err: any) {
    return {
      success: false,
      error: `clawhub publish 异常: ${err.message || String(err)}`,
    };
  }
}

/**
 * 发布技能到 GitHub 仓库。
 * 调用 `gh repo create` 创建仓库，然后 git init + commit + push。
 *
 * 流程：
 * 1. 在技能目录初始化 git 仓库
 * 2. 添加所有文件并提交
 * 3. 通过 gh CLI 创建 GitHub 仓库
 * 4. 推送到远程
 */
async function publishToGitHub(config: PublishConfig): Promise<PublishResult> {
  const { executeCommand } = await import("../file-api");
  const repoName = config.githubRepoName || config.slug;
  const visibility = config.githubPrivate ? "--private" : "--public";

  const outputParts: string[] = [];

  try {
    // 1. git init
    let result = await executeCommand("git init", config.skillPath);
    outputParts.push("[git init]", result.stdout, result.stderr);

    // 2. git add
    result = await executeCommand("git add -A", config.skillPath);
    outputParts.push("[git add]", result.stdout, result.stderr);

    // 3. git commit
    result = await executeCommand(
      `git commit -m "Publish skill: ${config.displayName} v${config.version}"`,
      config.skillPath,
    );
    outputParts.push("[git commit]", result.stdout, result.stderr);

    // 4. gh repo create
    result = await executeCommand(
      `gh repo create ${repoName} ${visibility} --source=. --push --description="Codem skill: ${config.displayName}"`,
      config.skillPath,
    );
    outputParts.push("[gh repo create]", result.stdout, result.stderr);

    if (result.exitCode !== 0 && result.exitCode !== undefined) {
      return {
        success: false,
        error: `GitHub 仓库创建失败: ${result.stderr}`,
        rawOutput: outputParts.join("\n"),
      };
    }

    // 从输出中提取仓库 URL
    const urlMatch = (result.stdout + result.stderr).match(/https:\/\/github\.com\/[^\s]+/i);
    const url = urlMatch ? urlMatch[0] : `https://github.com/${repoName}`;

    return {
      success: true,
      url,
      publishedId: repoName,
      rawOutput: outputParts.join("\n"),
    };
  } catch (err: any) {
    return {
      success: false,
      error: `GitHub 发布异常: ${err.message || String(err)}`,
      rawOutput: outputParts.join("\n"),
    };
  }
}

/**
 * 通过 CLI 子进程发布技能（通用 CLI 市场适配）。
 * 尝试调用 `<cliCommand> publish <path>` 命令。
 */
async function publishToCLI(config: PublishConfig): Promise<PublishResult> {
  const { executeCommand } = await import("../file-api");

  // 查找 CLI 命令
  const sources = getMarketSources();
  const source = sources.find((s) => s.id === config.sourceId);
  if (!source?.cliCommand) {
    return { success: false, error: "未找到 CLI 命令配置" };
  }

  const cmd = source.cliCommand;

  try {
    // 尝试 publish 命令（格式可能因 CLI 而异）
    const result = await executeCommand(
      `${cmd} publish "${config.skillPath}" --name "${config.displayName}" --version ${config.version}`,
      undefined,
    );
    const output = (result.stdout || "") + (result.stderr ? "\n" + result.stderr : "");

    if (result.exitCode !== 0 && result.exitCode !== undefined) {
      // publish 命令不支持，尝试 upload
      try {
        const result2 = await executeCommand(
          `${cmd} upload "${config.skillPath}" --name "${config.displayName}"`,
          undefined,
        );
        const output2 = (result2.stdout || "") + (result2.stderr ? "\n" + result2.stderr : "");
        if (result2.exitCode !== 0 && result2.exitCode !== undefined) {
          return {
            success: false,
            error: `${cmd} publish/upload 均不支持 (exit ${result2.exitCode}): ${result2.stderr}`,
            rawOutput: output + "\n---\n" + output2,
          };
        }
        return {
          success: true,
          publishedId: config.slug,
          rawOutput: output2,
        };
      } catch {
        return {
          success: false,
          error: `${cmd} 不支持 publish 命令`,
          rawOutput: output,
        };
      }
    }

    const urlMatch = output.match(/https?:\/\/[^\s]+/i);
    return {
      success: true,
      url: urlMatch ? urlMatch[0] : undefined,
      publishedId: config.slug,
      rawOutput: output,
    };
  } catch (err: any) {
    return {
      success: false,
      error: `${cmd} publish 异常: ${err.message || String(err)}`,
    };
  }
}

/**
 * 发布技能到市场（统一入口）。
 *
 * 根据目标市场类型分派到对应的发布实现：
 * - clawhub: 调用 `clawhub skill publish` CLI
 * - github:  通过 `gh repo create` + git push 创建 GitHub 仓库
 * - cli:     调用通用 `<cliCommand> publish` 命令
 *
 * @param config 发布配置
 * @returns 发布结果
 */
export async function publishSkillToMarket(config: PublishConfig): Promise<PublishResult> {
  // 验证技能路径
  if (!config.skillPath) {
    return { success: false, error: "技能路径不能为空" };
  }
  if (!config.slug) {
    return { success: false, error: "技能 slug 不能为空" };
  }
  if (!config.version) {
    return { success: false, error: "版本号不能为空" };
  }

  switch (config.target) {
    case "clawhub":
      return await publishToClawHub(config);
    case "github":
      return await publishToGitHub(config);
    case "cli":
      return await publishToCLI(config);
    default:
      return { success: false, error: `不支持的发布目标: ${config.target}` };
  }
}

/**
 * 预检发布（dry-run）。
 * 仅 ClawHub 支持 --dry-run，其他市场返回就绪状态。
 */
export async function dryRunPublish(config: PublishConfig): Promise<PublishResult> {
  if (config.target !== "clawhub") {
    // GitHub 和 CLI 不支持 dry-run，返回就绪检查
    const markets = await listPublishableMarkets();
    const market = markets.find((m) => m.target === config.target);
    if (market && !market.ready) {
      return { success: false, error: market.notReadyReason || "市场未就绪" };
    }
    return { success: true, rawOutput: "预检通过（该市场不支持 dry-run）" };
  }

  const { executeCommand } = await import("../file-api");
  try {
    const result = await executeCommand(
      `clawhub skill publish "${config.skillPath}" --slug ${config.slug} --name "${config.displayName}" --version ${config.version} --dry-run --json`,
      undefined,
    );
    const output = (result.stdout || "") + (result.stderr ? "\n" + result.stderr : "");

    if (result.exitCode !== 0 && result.exitCode !== undefined) {
      return {
        success: false,
        error: `dry-run 失败: ${result.stderr || output}`,
        rawOutput: output,
      };
    }

    return {
      success: true,
      rawOutput: output,
    };
  } catch (err: any) {
    return {
      success: false,
      error: `dry-run 异常: ${err.message || String(err)}`,
    };
  }
}
