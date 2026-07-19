/**
 * SkillInstaller — 技能 ZIP 安装/卸载。
 *
 * 工作流程：
 * 1. 用户选择或拖拽 ZIP 文件
 * 2. 使用 fflate 在前端解压
 * 3. 验证 ZIP 中是否包含 SKILL.md
 * 4. 将文件写入 ~/.codem/skills/<skill-name>/ 目录
 * 5. 解析 SKILL.md 并注册到 SkillRegistry
 *
 * 安全限制：
 * - ZIP 中路径不允许包含 .. 或绝对路径（防止目录穿越）
 * - 最大解压文件数：100
 * - 最大单文件大小：1MB
 * - 仅允许文本文件和常见资源文件
 */

import { unzipSync, strFromU8 } from "fflate";
import { getSkillRegistry, parseSkillMarkdown, type SkillDefinition } from "./skill";
import { writeFile, deletePath, listDirectory, readFile } from "../file-api";

/** 技能安装目录（~/.codem/skills/） */
async function getSkillsDir(): Promise<string> {
  const { invoke } = (window as any).__TAURI__?.core || {};
  if (invoke) {
    const home = await invoke("get_default_cwd");
    const sep = home.includes("/") && !home.includes("\\") ? "/" : "\\";
    return `${home}${sep}.codem${sep}skills`;
  }
  return ".codem/skills";
}

/** 安装结果 */
export interface InstallResult {
  success: boolean;
  skillName?: string;
  skill?: SkillDefinition;
  error?: string;
  filesWritten?: number;
}

/** 安装进度回调 */
export type InstallProgressCallback = (progress: number, message: string) => void;

/** 安全检查：路径是否合法 */
function isSafePath(path: string): boolean {
  // 禁止绝对路径和目录穿越
  if (path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(path)) {
    return false;
  }
  if (path.includes("..")) {
    return false;
  }
  return true;
}

/** 允许的文件扩展名 */
const ALLOWED_EXTENSIONS = new Set([
  ".md", ".txt", ".json", ".yaml", ".yml",
  ".ts", ".tsx", ".js", ".jsx", ".mjs",
  ".py", ".sh", ".bat", ".ps1",
  ".css", ".html", ".svg",
  ".png", ".jpg", ".jpeg", ".gif", ".ico",
  ".toml", ".ini", ".cfg",
]);

/** 最大文件数和大小限制 */
const MAX_FILES = 100;
const MAX_FILE_SIZE = 1024 * 1024; // 1MB

/**
 * 从 ZIP 文件安装技能。
 * @param zipData ZIP 文件的 Uint8Array 数据
 * @param onProgress 安装进度回调
 * @param overwrite 是否覆盖同名技能
 * @param preferredName 优先使用的技能名（如来自市场显示的名称）
 */
export async function installSkillFromZip(
  zipData: Uint8Array,
  onProgress?: InstallProgressCallback,
  overwrite: boolean = false,
  preferredName?: string,
): Promise<InstallResult> {
  try {
    onProgress?.(10, "正在解压 ZIP 文件...");

    // 解压 ZIP
    const files = unzipSync(zipData);

    // 查找 SKILL.md
    const skillMdPath = Object.keys(files).find((p) => p.endsWith("SKILL.md"));
    if (!skillMdPath) {
      return {
        success: false,
        error: "ZIP 文件中未找到 SKILL.md 文件。请确保 ZIP 包含技能定义文件。",
      };
    }

    // 确定 ZIP 内的根目录
    const rootDir = skillMdPath.includes("/") || skillMdPath.includes("\\")
      ? skillMdPath.replace(/[/\\]SKILL\.md$/i, "")
      : "";

    // 解析 SKILL.md
    const skillMdContent = strFromU8(files[skillMdPath]);
    const skill = parseSkillMarkdown(skillMdContent, skillMdPath);
    if (!skill) {
      return {
        success: false,
        error: "SKILL.md 解析失败，请检查文件格式。",
      };
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

    onProgress?.(30, `正在安装技能: ${skill.name}...`);

    // 获取安装目录
    const skillsDir = await getSkillsDir();
    const sep = skillsDir.includes("/") && !skillsDir.includes("\\") ? "/" : "\\";
    const skillDir = `${skillsDir}${sep}${skill.name}`;

    // 写入所有文件
    let filesWritten = 0;
    const allPaths = Object.keys(files);
    const totalFiles = allPaths.length;

    for (const zipPath of allPaths) {
      // 安全检查
      if (!isSafePath(zipPath)) {
        console.warn(`[SkillInstaller] Skipping unsafe path: ${zipPath}`);
        continue;
      }

      // 去除根目录前缀
      let relativePath = zipPath;
      if (rootDir && (zipPath.startsWith(rootDir + "/") || zipPath.startsWith(rootDir + "\\"))) {
        relativePath = zipPath.substring(rootDir.length + 1);
      }
      if (!relativePath) continue;

      // 检查文件扩展名
      const ext = relativePath.substring(relativePath.lastIndexOf(".")).toLowerCase();
      if (!ALLOWED_EXTENSIONS.has(ext) && !relativePath.endsWith("/")) {
        console.warn(`[SkillInstaller] Skipping file with disallowed extension: ${relativePath}`);
        continue;
      }

      // 跳过目录
      if (zipPath.endsWith("/") || zipPath.endsWith("\\")) continue;

      // 检查文件大小
      const fileData = files[zipPath];
      if (fileData.length > MAX_FILE_SIZE) {
        console.warn(`[SkillInstaller] Skipping oversized file: ${relativePath} (${fileData.length} bytes)`);
        continue;
      }

      // 检查文件数限制
      if (filesWritten >= MAX_FILES) {
        console.warn(`[SkillInstaller] Max file limit reached (${MAX_FILES})`);
        break;
      }

      // 写入文件
      const fullPath = `${skillDir}${sep}${relativePath.replace(/\//g, sep)}`;
      const content = strFromU8(fileData);
      await writeFile(fullPath, content);
      filesWritten++;

      // 更新进度
      const progress = 30 + Math.round((filesWritten / totalFiles) * 60);
      onProgress?.(progress, `写入文件: ${relativePath}`);
    }

    onProgress?.(90, "正在注册技能...");

    // 设置来源为 user 并注册
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
 * 卸载（删除）技能。
 * 删除技能目录和注册表中的记录。
 */
export async function uninstallSkill(skillName: string): Promise<{ success: boolean; error?: string }> {
  try {
    const registry = getSkillRegistry();
    const skill = registry.get(skillName);
    if (!skill) {
      return { success: false, error: `技能 "${skillName}" 不存在。` };
    }

    // 不允许删除内置技能
    if (skill.source === "builtin") {
      return { success: false, error: "内置技能不可删除。" };
    }

    // 删除技能目录
    if (skill.filePath) {
      const skillsDir = await getSkillsDir();
      const sep = skillsDir.includes("/") && !skillsDir.includes("\\") ? "/" : "\\";
      const skillDir = skill.filePath || `${skillsDir}${sep}${skillName}`;
      try {
        await deletePath(skillDir);
      } catch (err) {
        console.warn(`[SkillInstaller] Failed to delete skill directory:`, err);
      }
    }

    // 从注册表移除
    registry.remove(skillName);

    return { success: true };
  } catch (err: any) {
    return { success: false, error: `卸载失败: ${err.message || String(err)}` };
  }
}

/**
 * 从目录加载已安装的技能。
 * 在应用启动时调用。
 */
export async function loadInstalledSkills(): Promise<number> {
  const skillsDir = await getSkillsDir();
  const registry = getSkillRegistry();

  let loaded = 0;
  try {
    const entries = await listDirectory(skillsDir);
    for (const entry of entries) {
      if (!entry.isDirectory) continue;
      try {
        const sep = skillsDir.includes("/") && !skillsDir.includes("\\") ? "/" : "\\";
        const skillMdPath = `${entry.path}${sep}SKILL.md`;
        const content = await readFile(skillMdPath);
        const skill = parseSkillMarkdown(content, entry.path);
        if (skill) {
          skill.source = "user";
          skill.filePath = entry.path;
          registry.register(skill);
          loaded++;
        }
      } catch {
        // Skip invalid skills
      }
    }
  } catch {
    // Skills directory doesn't exist yet — that's fine
  }
  return loaded;
}

/**
 * 读取 ZIP 文件为 Uint8Array。
 */
export function readZipFile(file: File): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(new Error("Failed to read ZIP file"));
    reader.readAsArrayBuffer(file);
  });
}
