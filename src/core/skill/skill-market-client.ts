/**
 * SkillMarketClient — 技能市场客户端。
 *
 * 架构方案 B+C：通过 Tauri Rust 层的 http_get / http_download 命令代理 HTTP 请求，
 * 绕过前端 CSP 限制，无需额外运行时依赖。
 *
 * 支持的市场源类型：
 * 1. github-repo  — GitHub 仓库目录型（如 anthropics/skills，每个子目录是一个技能）
 * 2. github-search — GitHub 话题搜索型（搜索 topic:agent-skills 的仓库）
 * 3. builtin      — 内置技能展示型（展示 Codem 自带技能，无需下载）
 *
 * IP 声明：本文件所有代码均为原创实现，仅使用 GitHub 公开 REST API。
 */

import { installSkillFromZip, type InstallResult, type InstallProgressCallback } from "./installer";
import { getSkillRegistry, parseSkillMarkdown, type SkillDefinition } from "./skill";
import { writeFile, readFile, deletePath } from "../file-api";
import { getSettingJSON, setSettingJSON } from "../storage/settings";

// ========== Types ==========

/** 市场源类型 */
export type MarketSourceType = "github-repo" | "github-search" | "builtin";

/** 市场源配置 */
export interface MarketSource {
  id: string;
  name: string;
  type: MarketSourceType;
  /** GitHub API URL 或搜索查询 */
  url: string;
  /** 是否启用 */
  enabled: boolean;
  /** 图标 emoji（用于 UI 展示） */
  icon?: string;
  /** 子目录路径（仅 github-repo 类型）。如果仓库技能不在根目录而在子目录中，指定该子目录名。 */
  subdir?: string;
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
    url: "https://api.github.com/search/repositories?q=topic:agent-skills+topic:claude&sort=stars&order=desc&per_page=30",
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

    for (const repo of data.items) {
      // 尝试获取 SKILL.md 内容以提取元数据
      let description = repo.description || "";
      let displayName = repo.name;
      let author = repo.owner?.login || "";
      let tags: string[] | undefined;
      let version: string | undefined;

      try {
        const branch = await getDefaultBranch(repo.full_name);
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

      skills.push({
        id: `${source.id}:${repo.full_name}`,
        name: repo.name,
        displayName,
        description: description || "无描述",
        author,
        version,
        tags: tags || repo.topics,
        sourceId: source.id,
        sourceName: source.name,
        downloadUrl: `https://api.github.com/repos/${repo.full_name}/zipball/${repo.default_branch || "main"}`,
        repoUrl: repo.html_url,
        stars: repo.stargazers_count,
        lastUpdated: repo.updated_at,
        installType: "zip",
        repoFullName: repo.full_name,
        branch: repo.default_branch || "main",
      });
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

  // 并行加载所有源
  const promises = activeSources.map(async (source) => {
    try {
      let skills: MarketSkill[] = [];
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
      }

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
  const home = await tauriInvoke("get_default_cwd");
  const sep = home.includes("/") && !home.includes("\\") ? "/" : "\\";
  return `${home}${sep}.codem${sep}skills`;
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

  try {
    onProgress?.(5, "正在准备下载...");

    // 获取临时文件路径
    const skillsDir = await getSkillsDir();
    const sep = skillsDir.includes("/") && !skillsDir.includes("\\") ? "/" : "\\";
    const tempZipPath = `${skillsDir}${sep}.tmp${sep}${skill.sourceId}-${skill.name}.zip`;

    onProgress?.(15, `正在下载技能包: ${skill.displayName}...`);

    // 通过 Rust 层下载 ZIP 文件
    await httpDownload(skill.downloadUrl, tempZipPath, githubApiHeaders());

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
    return await installSkillFromZip(zipData, onProgress, overwrite, skill.name);
  } catch (err: any) {
    return {
      success: false,
      error: `市场安装失败: ${err.message || String(err)}`,
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
      return {
        success: false,
        error: `ZIP 中未找到目录 "${targetDir}"。`,
      };
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
 * 获取市场源图标。
 */
export function getSourceIcon(source: MarketSource): string {
  return source.icon || "📦";
}
