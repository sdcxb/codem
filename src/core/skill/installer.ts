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
import { writeFile, deleteDirectoryPermanent, deleteFile, listDirectory, readFile } from "../file-api";
import { diagTrail } from "./skill-delete-diag";

import { getAppDataDir } from "../file-api";

/** 技能安装目录（app_data/.codem/skills/） */
async function getSkillsDir(): Promise<string> {
  const { invoke } = (window as any).__TAURI__?.core || {};
  if (invoke) {
    const dataDir = await getAppDataDir();
    const sep = dataDir.includes("/") && !dataDir.includes("\\") ? "/" : "\\";
    return `${dataDir}.codem${sep}skills`;
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
  /**
   * 第 86 波：被跳过的文件（不安全路径 / 扩展名不允许 / 过大 / 超上限）。
   * 有值时说明"技能装上了但不完整"，调用方应当提示用户。
   */
  skipped?: Array<{ path: string; reason: string }>;
  warning?: string;
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
    /**
     * 第 86 波（假成功）：被跳过的文件（路径不安全 / 扩展名不允许 / 过大 / 超出文件数上限）
     * 原来只写 console.warn，函数照样返回 `success: true` ——
     * 技能可能只装了一半（例如 SKILL.md 装上了、脚本没装上），调用方与用户都看不出。
     */
    const skipped: Array<{ path: string; reason: string }> = [];
    const allPaths = Object.keys(files);
    const totalFiles = allPaths.length;

    for (const zipPath of allPaths) {
      // 安全检查
      if (!isSafePath(zipPath)) {
        console.warn(`[SkillInstaller] Skipping unsafe path: ${zipPath}`);
        skipped.push({ path: zipPath, reason: "不安全的路径" });
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
        skipped.push({ path: relativePath, reason: `扩展名 ${ext} 不在允许列表内` });
        continue;
      }

      // 跳过目录
      if (zipPath.endsWith("/") || zipPath.endsWith("\\")) continue;

      // 检查文件大小
      const fileData = files[zipPath];
      if (fileData.length > MAX_FILE_SIZE) {
        console.warn(`[SkillInstaller] Skipping oversized file: ${relativePath} (${fileData.length} bytes)`);
        skipped.push({ path: relativePath, reason: `文件过大（${fileData.length} 字节 > ${MAX_FILE_SIZE}）` });
        continue;
      }

      // 检查文件数限制
      if (filesWritten >= MAX_FILES) {
        console.warn(`[SkillInstaller] Max file limit reached (${MAX_FILES})`);
        skipped.push({ path: relativePath, reason: `超出单技能文件数上限（${MAX_FILES}）` });
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

    // 第 86 波：一个文件都没写进去 = 安装失败（不能让"全部被跳过"变成成功）
    if (filesWritten === 0) {
      return {
        success: false,
        skillName: skill.name,
        error:
          `安装失败：压缩包里的文件全部被跳过（${skipped.map((s) => `${s.path}: ${s.reason}`).join("；") || "没有可写入的文件"}）`,
        skipped,
      };
    }

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
      // 部分文件被跳过时如实带出来（调用方据此提示"安装不完整"）
      ...(skipped.length > 0 ? { skipped, warning: `${skipped.length} 个文件被跳过，技能可能不完整` } : {}),
    };
  } catch (err: any) {
    return {
      success: false,
      error: `安装失败: ${err.message || String(err)}`,
    };
  }
}

/**
 * 删除原语的兜底时限。原生调用一旦永远不返回，界面就会永久停在"删除中"——
 * 有界失败（并说明下一步）远好过无限等待。
 */
const DELETE_TIMEOUT_MS = 30_000;

/** 区分"超时"与普通失败，超时不再退避重试（免得又挂 30 秒）。 */
class DeleteTimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new DeleteTimeoutError(`${label} 超过 ${Math.round(ms / 1000)} 秒没有返回`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * 删除目标护栏：返回非空字符串表示"拒绝删除"的理由。
 *
 * 技能目录必须是技能根目录的**子目录**（或项目级 `.codem/skills/<名>`）。
 * 目标是技能根目录本身、它的上级、盘符根 —— 都拒绝：那些目标要么意味着记录已被写坏，
 * 要么会是"删掉一片不属于这个技能的东西"。
 */
async function checkDeleteTarget(skillDir: string): Promise<string | null> {
  const normalize = (p: string): string =>
    p.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
  const target = normalize(skillDir);
  if (!target) return "拒绝删除：目标路径为空。";

  try {
    const skillsRoot = normalize(await getSkillsDir());
    if (target === skillsRoot || skillsRoot.startsWith(`${target}\\`)) {
      return `拒绝删除：目标 "${skillDir}" 是技能根目录或其上级目录，不是某个技能自己的目录。`;
    }
  } catch {
    /* 取不到技能根目录时不拦（护栏不能变成新的失败源） */
  }
  // 盘符根 / UNC 根：路径里没有可删的目录段
  if (/^[a-z]:$/.test(target) || /^\\\\[^\\]+\\?[^\\]*$/.test(target)) {
    return `拒绝删除：目标 "${skillDir}" 是根目录。`;
  }
  return null;
}

/**
 * 卸载（删除）技能。
 * 删除技能目录和注册表中的记录。
 *
 * 三条必须遵守的约束：
 * 1. 用**永久删除**（`deleteDirectoryPermanent`）。技能目录是应用自管数据，走回收站既无必要，
 *    也会经过"可能弹系统对话框"的旧路径 —— 那条路曾在没人能点对话框时无限等待，
 *    表现为「删除技能」卡死。
 * 2. **删除失败必须如实报错，并且不把技能从注册表移除**。以前删除失败只 warn 就返回成功：
 *    界面上技能消失了，磁盘上的文件夹还在，下次启动又会被扫描回来（"删了又回来"）。
 * 3. **删除必须有界**：超时按失败处理并给出下一步，不把界面永久挂在"删除中"。
 */
export async function uninstallSkill(skillName: string): Promise<{ success: boolean; error?: string }> {
  diagTrail("uninstallSkill entered", { skillName });
  try {
    const registry = getSkillRegistry();
    const skill = registry.get(skillName);
    if (!skill) {
      diagTrail("uninstallSkill aborted: skill not registered", { skillName });
      return { success: false, error: `技能 "${skillName}" 不存在。` };
    }

    // 不允许删除内置技能
    if (skill.source === "builtin") {
      diagTrail("uninstallSkill aborted: builtin", { skillName });
      return { success: false, error: "内置技能不可删除。" };
    }

    // 删除技能目录（技能目录是目录；provider 技能可能指向单个文件，退回单文件删除）
    if (skill.filePath) {
      const skillDir = skill.filePath;

      // 兜底护栏：目标既不能是技能根目录本身，也不能是它的上级。
      // 一旦记录的路径被写坏（例如指向 %APPDATA%\.codem\skills 或更上层），删除会变成
      // "删掉全部技能"甚至更糟，而且这种目标通常很大、耗时不可预测 —— 直接拒绝并说清原因。
      const guard = await checkDeleteTarget(skillDir);
      if (guard) {
        diagTrail("uninstallSkill refused by path guard", { skillName, path: skillDir, reason: guard });
        return { success: false, error: guard };
      }

      diagTrail("uninstallSkill deleting", {
        skillName,
        source: skill.source,
        path: skillDir,
      });
      console.log(`[SkillInstaller] uninstall "${skillName}" → 永久删除 ${skillDir}`);
      try {
        await withTimeout(deleteDirectoryPermanent(skillDir), DELETE_TIMEOUT_MS, "删除技能目录");
        diagTrail("uninstallSkill directory removed", { skillName, path: skillDir });
      } catch (dirError) {
        const timedOut = dirError instanceof DeleteTimeoutError;
        const firstReason = dirError instanceof Error ? dirError.message : String(dirError);
        diagTrail("uninstallSkill directory delete failed", { skillName, path: skillDir, timedOut, reason: firstReason });
        if (!timedOut) {
          // provider 技能可能指向单个文件
          try {
            await withTimeout(deleteFile(skillDir), DELETE_TIMEOUT_MS, "删除技能文件");
            diagTrail("uninstallSkill single file removed", { skillName, path: skillDir });
            console.log(`[SkillInstaller] uninstall "${skillName}" → 单文件删除完成`);
            registry.remove(skillName);
            return { success: true };
          } catch {
            /* 落到下面的失败分支 */
          }
        }
        const reason = firstReason;
        console.warn(`[SkillInstaller] uninstall "${skillName}" failed:`, reason);
        diagTrail("uninstallSkill failed", { skillName, path: skillDir, timedOut, reason });
        return {
          success: false,
          error: timedOut
            ? `${reason}。技能仍保留在列表中；若目录被其他程序占用，请关闭占用后重试（目录：${skillDir}）`
            : `技能文件删除失败：${reason}。技能仍保留在列表中，可重试或手动删除目录 ${skillDir}`,
        };
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
    const sep = skillsDir.includes("/") && !skillsDir.includes("\\") ? "/" : "\\";
    for (const entry of entries) {
      if (!entry.isDirectory) continue;
      // 结构上不可能是技能的目录直接跳过并留痕（用户在技能管理里看到过一个叫 "skills" 的
      // 幽灵技能：它是技能根目录下一个名为 SKILL.md 的目录，被当成技能名兜底成了父目录名）。
      // 这类目录只会让人"删一个根本不该存在的技能"，明确报出来比静默注册更有用。
      if (entry.name.toLowerCase() === "skill.md") {
        console.warn(
          `[SkillInstaller] 跳过结构异常的目录 "${entry.path}"：名为 SKILL.md 的目录不是技能目录，` +
            `请把技能放在 skills\\<技能名>\\SKILL.md 下`,
        );
        continue;
      }
      try {
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
