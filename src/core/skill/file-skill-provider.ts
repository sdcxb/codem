/**
 * File-based Skill Discovery Provider
 *
 * A5: 实现 SkillDiscoveryProvider 接口，从文件系统目录发现 SKILL.md 文件。
 * 这是 A2 引入的 Provider 接口的第一个具体实现。
 *
 * 工作机制：
 * 1. 扫描指定目录（支持多 root）
 * 2. 发现 SKILL.md 文件
 * 3. 解析 frontmatter 生成 SkillCandidate
 * 4. 按需加载完整 SkillDefinition
 */

import type {
  SkillCandidate,
  SkillDefinition,
  SkillDiscoveryProvider,
  SkillInvocationPolicy,
  SkillLookupOptions,
  SkillProviderControl,
  SkillSummary,
} from "./skill";
import { parseSkillMarkdown } from "./skill";
import * as fs from "fs";
import * as path from "path";

// ========== Cache Entry ==========

interface CachedSkill {
  definition: SkillDefinition;
  mtime: number;
  filePath: string;
}

// ========== FileSkillProvider ==========

/**
 * 从文件系统目录发现技能的 Provider。
 *
 * 支持：
 * - 多 root 目录扫描
 * - 文件变更监听（通过 mtime 比较）
 * - 增量刷新
 */
export function createFileSkillProvider(
  roots: string[],
  source: "builtin" | "project" | "user" | "external" = "builtin",
  control?: SkillProviderControl,
): SkillDiscoveryProvider {
  const cache = new Map<string, CachedSkill>();
  let lastScanTime = 0;

  const provider: SkillDiscoveryProvider = {
    name: `file:${source}`,

    async list(options: SkillLookupOptions): Promise<SkillCandidate[]> {
      const candidates: SkillCandidate[] = [];

      for (const root of roots) {
        if (!fs.existsSync(root)) continue;

      const entries = scanSkillFiles(root);

      for (const filePath of entries) {
        try {
          const stat = fs.statSync(filePath);
          const cached = cache.get(filePath);

          // 检查是否需要重新读取
          if (cached && cached.mtime === stat.mtimeMs) {
            // 使用缓存的定义生成 candidate
            candidates.push(toCandidate(cached.definition, filePath, source, provider.name));
          } else {
            // 读取并解析
            const content = fs.readFileSync(filePath, "utf-8");
            const skill = parseSkillMarkdown(content, filePath);
            if (skill) {
              skill.source = source;
              skill.filePath = filePath;
              cache.set(filePath, {
                definition: skill,
                mtime: stat.mtimeMs,
                filePath,
              });
              candidates.push(toCandidate(skill, filePath, source, provider.name));
            }
          }
        } catch (error) {
          console.warn(`[FileSkillProvider] Failed to parse ${filePath}: ${error}`);
        }
      }
      }

      lastScanTime = Date.now();
      return candidates;
    },

    async get(
      candidate: SkillCandidate,
      _options: SkillLookupOptions,
    ): Promise<SkillDefinition | undefined> {
      // 从缓存或文件加载
      const filePath = candidate.path;
      if (!filePath) return undefined;

      const cached = cache.get(filePath);
      if (cached) {
        // 验证文件未变更
        try {
          const stat = fs.statSync(filePath);
          if (cached.mtime === stat.mtimeMs) {
            return cached.definition;
          }
        } catch {
          // 文件可能已删除
          cache.delete(filePath);
          return undefined;
        }
      }

      // 重新读取
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        const skill = parseSkillMarkdown(content, filePath);
        if (skill) {
          skill.source = source;
          skill.filePath = filePath;
          const stat = fs.statSync(filePath);
          cache.set(filePath, {
            definition: skill,
            mtime: stat.mtimeMs,
            filePath,
          });
          return skill;
        }
      } catch {
        // 文件读取失败
      }

      return undefined;
    },
  };

  return provider;
}

// ========== Helpers ==========

/** 递归扫描目录下的 SKILL.md 文件 */
function scanSkillFiles(root: string): string[] {
  const results: string[] = [];

  function scan(dir: string, depth: number) {
    if (depth > 5) return; // 限制递归深度

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      // 排除 node_modules 和 vendor
      if (entry.name === "node_modules" || entry.name === "vendor" || entry.name === ".git") {
        continue;
      }

      if (entry.isDirectory()) {
        scan(fullPath, depth + 1);
      } else if (entry.name === "SKILL.md" || (entry.name.endsWith(".md") && entry.name !== "AGENTS.md")) {
        results.push(fullPath);
      }
    }
  }

  scan(root, 0);
  return results;
}

/** 将 SkillDefinition 转换为 SkillCandidate */
function toCandidate(
  skill: SkillDefinition,
  filePath: string,
  source: string,
  providerName: string,
): SkillCandidate {
  const invocation: SkillInvocationPolicy = {
    modelInvocable: true,
    userInvocable: true,
  };

  return {
    name: skill.name,
    description: skill.description,
    ...(skill.whenToUse ? { whenToUse: skill.whenToUse } : {}),
    invocation,
    source,
    provider: providerName,
    resourceBase: { kind: "directory", path: path.dirname(filePath) },
    rank: 0,
    locator: filePath,
    path: filePath,
    metadata: {
      ...(skill.tags ? { tags: skill.tags } : {}),
      ...(skill.version ? { version: skill.version } : {}),
      ...(skill.aliases ? { aliases: skill.aliases } : {}),
    },
  };
}
